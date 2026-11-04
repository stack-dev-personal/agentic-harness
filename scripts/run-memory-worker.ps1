param([string] $NodePath = 'node')
$ErrorActionPreference = 'Stop'
$worker = Join-Path (Split-Path -Parent $PSScriptRoot) 'hooks/memory-worker.mjs'
& $NodePath $worker
exit $LASTEXITCODE
