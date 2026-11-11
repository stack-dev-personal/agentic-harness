<#
.SYNOPSIS
    Self-test for scripts/set-task-windowless.ps1. No Pester needed.

.DESCRIPTION
    Registers one throwaway Interactive task, runs set-task-windowless.ps1
    against it in a child `powershell -NoProfile -File` (so its `exit` codes are
    the real ones), and prints PASS or FAIL per case. The task is removed in
    `finally`. Exits 1 if any case failed.

    It never switches a real harness task. The S4U switch itself needs an
    elevated shell: that case runs only when this test is elevated and is
    reported as SKIP otherwise.

.EXAMPLE
    powershell -NoProfile -File scripts/tests/set-task-windowless.tests.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$script:Target = Join-Path (Split-Path -Parent $PSScriptRoot) 'set-task-windowless.ps1'
$script:ChildShell = 'powershell'
$script:ProbeTask = 'AgenticHarness-WindowlessSelfTest-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$script:Failures = 0

function Invoke-Target {
    param([string[]] $Arguments)
    # Windows PowerShell 5.1 turns a child's stderr line into an error record;
    # under 'Stop' that would end the test at the first expected failure message.
    $ErrorActionPreference = 'Continue'
    $output = & $script:ChildShell -NoProfile -File $script:Target @Arguments 2>&1 | Out-String
    return [PSCustomObject]@{ Code = $LASTEXITCODE; Output = $output }
}

function Assert-Case {
    param([string] $Name, [bool] $Passed, [string] $Detail = '')
    if ($Passed) { Write-Output "PASS  $Name" }
    else { $script:Failures += 1; Write-Output "FAIL  $Name  $Detail" }
}

function Get-ProbeLogonType { return "$((Get-ScheduledTask -TaskName $script:ProbeTask).Principal.LogonType)" }

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

try {
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument '/c exit 0'
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    # No trigger: the probe never runs by itself.
    Register-ScheduledTask -TaskName $script:ProbeTask -Action $action -Principal $principal | Out-Null

    $missing = Invoke-Target @('-TaskName', 'AgenticHarness-NoSuchTask-SelfTest')
    Assert-Case 'a missing task exits 2' ($missing.Code -eq 2) "exit $($missing.Code)"

    $mixed = Invoke-Target @('-TaskName', "$script:ProbeTask,AgenticHarness-NoSuchTask-SelfTest", '-Apply')
    Assert-Case 'one missing name changes nothing' ((Get-ProbeLogonType) -eq 'Interactive') "logon type $(Get-ProbeLogonType)"

    $preview = Invoke-Target @('-TaskName', $script:ProbeTask)
    Assert-Case 'preview exits 0' ($preview.Code -eq 0) "exit $($preview.Code)"
    Assert-Case 'preview says what would change' ($preview.Output -match 'Interactive -> S4U \(would change\)') $preview.Output.Trim()
    Assert-Case 'preview changes nothing' ((Get-ProbeLogonType) -eq 'Interactive') "logon type $(Get-ProbeLogonType)"

    $same = Invoke-Target @('-TaskName', $script:ProbeTask, '-LogonType', 'Interactive', '-Apply')
    Assert-Case 'applying the current type is a no-op' ($same.Code -eq 0 -and $same.Output -match 'already set') $same.Output.Trim()

    if (Test-Elevated) {
        $applied = Invoke-Target @('-TaskName', $script:ProbeTask, '-Apply')
        Assert-Case 'elevated apply exits 0' ($applied.Code -eq 0) "exit $($applied.Code): $($applied.Output.Trim())"
        Assert-Case 'elevated apply sets S4U' ((Get-ProbeLogonType) -eq 'S4U') "logon type $(Get-ProbeLogonType)"
        $reverted = Invoke-Target @('-TaskName', $script:ProbeTask, '-LogonType', 'Interactive', '-Apply')
        Assert-Case 'revert sets Interactive' ($reverted.Code -eq 0 -and (Get-ProbeLogonType) -eq 'Interactive') "exit $($reverted.Code), logon type $(Get-ProbeLogonType)"
    } else {
        $refused = Invoke-Target @('-TaskName', $script:ProbeTask, '-Apply')
        Assert-Case 'apply without elevation exits 3' ($refused.Code -eq 3) "exit $($refused.Code)"
        Assert-Case 'apply without elevation changes nothing' ((Get-ProbeLogonType) -eq 'Interactive') "logon type $(Get-ProbeLogonType)"
        Write-Output 'SKIP  elevated apply and revert (this shell is not elevated)'
    }
} finally {
    Unregister-ScheduledTask -TaskName $script:ProbeTask -Confirm:$false -ErrorAction SilentlyContinue
}

if ($script:Failures -gt 0) { Write-Output "$script:Failures case(s) failed."; exit 1 }
Write-Output 'All cases passed.'
exit 0
