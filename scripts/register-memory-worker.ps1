[CmdletBinding()]
param(
  [string] $TaskName = 'AgenticHarness-Memory',
  [string] $NodePath = '',
  [switch] $Apply
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-memory-worker.ps1'
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$powerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
if (-not $Apply) {
  [PSCustomObject]@{ TaskName=$TaskName; Interval='5 minutes'; Worker=(Join-Path $repo 'hooks/memory-worker.mjs'); Hidden=$true; Apply=$false }
  return
}
$backups = Join-Path $env:USERPROFILE '.harness/task-backups'
New-Item -ItemType Directory -Path $backups -Force | Out-Null
foreach ($existingName in @($TaskName, 'AgenticHarness-CodexIngest') | Select-Object -Unique) {
  $existing = Get-ScheduledTask -TaskName $existingName -ErrorAction SilentlyContinue
  if ($existing) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-ffff'
    Export-ScheduledTask -TaskName $existingName | Set-Content -LiteralPath (Join-Path $backups "$existingName-$stamp.xml") -Encoding UTF8
  }
}
$action = New-ScheduledTaskAction -Execute $powerShell `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$runner`" -NodePath `"$NodePath`"" `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Shared Claude Code, Codex and Hermes session checkpoints, durable ingestion retries, every five minutes.' -Force | Out-Null
if ($TaskName -ne 'AgenticHarness-CodexIngest') {
  $legacy = Get-ScheduledTask -TaskName 'AgenticHarness-CodexIngest' -ErrorAction SilentlyContinue
  if ($legacy) { $legacy | Disable-ScheduledTask | Out-Null }
}
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State
