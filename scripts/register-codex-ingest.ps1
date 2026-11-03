[CmdletBinding()]
param(
  [string] $TaskName = 'AgenticHarness-CodexIngest',
  [string] $NodePath = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$worker = Join-Path $repo 'hooks\codex-ingest-queue.mjs'
if (-not (Test-Path -LiteralPath $worker)) { throw "Missing worker: $worker" }
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $NodePath)) { throw "Missing Node: $NodePath" }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path

$action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$worker`"" -WorkingDirectory (Join-Path $repo 'hooks')
$trigger = New-ScheduledTaskTrigger -Daily -At '03:15'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description 'Ingest queued Codex notes after SessionEnd; sweep idle chats and retry pending notes daily at 03:15.' `
  -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
