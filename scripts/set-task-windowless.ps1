<#
.SYNOPSIS
    Make an existing harness scheduled task run without a desktop window.

.DESCRIPTION
    A task whose principal has logon type Interactive runs in the signed-in
    user's desktop session. Windows opens a console window for powershell.exe
    or node.exe before any "hidden" switch takes effect, and that window takes
    keyboard focus for a moment, every run.

    Logon type S4U ("Run whether user is logged on or not", with no stored
    password) runs the task in session 0, which has no desktop, so no window
    can appear. This script changes only the principal of each named task. The
    action, the triggers and the settings are kept exactly as they are, so a
    trigger that was edited by hand is not reverted.

    Preview by default: without -Apply it reports what would change and changes
    nothing. With -Apply it first exports each task's XML to
    ~/.harness/task-backups, then sets the principal.

    Windows only lets an elevated process register an S4U principal. Run it
    from a PowerShell started with "Run as administrator".

    An S4U task has no network credentials for Windows file shares. The harness
    tasks use local files and outbound HTTPS only, so nothing they do needs them.

.PARAMETER TaskName
    The tasks to change. Default: the memory worker and the checkpoint collector.

.PARAMETER LogonType
    S4U (default, windowless) or Interactive (the previous behaviour, to revert).

.PARAMETER Apply
    Make the change. Without it the script only reports.

.EXAMPLE
    ./set-task-windowless.ps1
    ./set-task-windowless.ps1 -Apply
    ./set-task-windowless.ps1 -Apply -LogonType Interactive   # revert

.NOTES
    Exit codes: 0 done or nothing to do, 2 a named task does not exist,
    3 -Apply to S4U without elevation, 4 a task could not be changed.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string[]] $TaskName = @('AgenticHarness-Memory', 'AgenticHarness-CheckpointCollect'),
    [ValidateSet('S4U', 'Interactive')]
    [string] $LogonType = 'S4U',
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'

$EXIT_MISSING = 2
$EXIT_NOT_ELEVATED = 3
$EXIT_FAILED = 4

function Fail {
    param([int] $Code, [string] $Message, [string] $Fix)
    # Not Write-Error: with $ErrorActionPreference = 'Stop' that would end the
    # script before `exit`, and the caller would see exit 1 instead.
    [Console]::Error.WriteLine("$Message`n  Fix: $Fix")
    exit $Code
}

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Every name is checked before anything changes, so a typo cannot leave one task
# switched and the next one not.
$tasks = @()
foreach ($name in $TaskName) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Fail $EXIT_MISSING "No scheduled task named '$name'." 'Register it first, or pass -TaskName with the tasks that exist.'
    }
    $tasks += $task
}

$pending = @($tasks | Where-Object { "$($_.Principal.LogonType)" -ne $LogonType })

foreach ($task in $tasks) {
    $current = "$($task.Principal.LogonType)"
    $verdict = if ($current -eq $LogonType) { 'already set' } elseif ($Apply) { 'changing' } else { 'would change' }
    Write-Output ("{0}: logon type {1} -> {2} ({3})" -f $task.TaskName, $current, $LogonType, $verdict)
}

if (-not $Apply) {
    if ($pending.Count -gt 0) { Write-Output 'Preview only. Run again with -Apply from an elevated PowerShell to make the change.' }
    exit 0
}
if ($pending.Count -eq 0) { exit 0 }

if ($LogonType -eq 'S4U' -and -not (Test-Elevated)) {
    Fail $EXIT_NOT_ELEVATED 'Windows only lets an elevated process register an S4U task.' 'Start PowerShell with "Run as administrator" and run this again.'
}

$backups = Join-Path $env:USERPROFILE '.harness/task-backups'
New-Item -ItemType Directory -Path $backups -Force | Out-Null

$failed = 0
foreach ($task in $pending) {
    $name = $task.TaskName
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-ffff'
    $backup = Join-Path $backups "$name-$stamp.xml"
    try {
        Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath $backup -Encoding UTF8
        # The same user and run level as before: only where the task runs changes.
        $principal = New-ScheduledTaskPrincipal -UserId $task.Principal.UserId -LogonType $LogonType -RunLevel $task.Principal.RunLevel
        Set-ScheduledTask -TaskName $name -Principal $principal | Out-Null
        $now = "$((Get-ScheduledTask -TaskName $name).Principal.LogonType)"
        if ($now -ne $LogonType) { throw "the task still reports logon type $now" }
        Write-Output "$name`: now $LogonType. Backup: $backup"
    } catch {
        $failed += 1
        [Console]::Error.WriteLine("$name`: not changed ($($_.Exception.Message.Trim())). Backup: $backup")
    }
}

if ($failed -gt 0) { exit $EXIT_FAILED }
Write-Output 'Verify with: Start-ScheduledTask -TaskName <name>; Get-ScheduledTaskInfo -TaskName <name>'
exit 0
