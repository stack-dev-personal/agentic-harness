[CmdletBinding()]
param([string] $TaskName = 'AgenticHarness-Memory', [string] $NodePath = '')
# Backward-compatible installer name; scheduling and policy are shared by all runtimes.
& (Join-Path $PSScriptRoot 'register-memory-worker.ps1') -TaskName $TaskName -NodePath $NodePath -Apply