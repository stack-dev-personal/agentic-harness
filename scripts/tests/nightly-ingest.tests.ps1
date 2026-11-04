<#
.SYNOPSIS
    Self-test for scripts/nightly-ingest.ps1. No Pester, no uv, no node, no store.

.DESCRIPTION
    Runs nightly-ingest.ps1 in a child `powershell -NoProfile -File` (so its
    `exit` codes are the real ones) against a scratch vault, a scratch project
    holding an empty pyproject.toml, a scratch hooks folder holding empty .mjs
    files, and two fakes passed by full path: uv.cmd and node.cmd. Nothing real
    runs: the fake uv echoes its arguments and exits with $env:FAKE_INGEST_CODE,
    $env:FAKE_VERIFY_CODE or $env:FAKE_EVAL_CODE by subcommand; the fake node
    echoes and exits 0. So no ingest, no prune, no realm push, no database.

    The cases read the script's own log file. They cover the verify and eval
    steps (R-Q1, R-Q3): that they run after the ingest and before the realm
    push, with the right arguments; that a failure is logged and never changes
    the exit code, which stays the ingest's; that -Verify and -Eval Skip switch
    them off. Static checks cover the parse, the header's step list, that
    `exit $ingestCode` is the last statement, and that the machine-env setting
    lists in lib/machine-env.ps1 and lib/machine-env.sh are identical.

    The machine file is pointed at a path that does not exist, so this
    machine's settings never leak in. The scratch folder and every environment
    change are undone in `finally`. Exits 1 if any case failed.

.EXAMPLE
    powershell -NoProfile -File scripts/tests/nightly-ingest.tests.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# The script under test and the two machine-env readers, one folder up from this one.
$script:ScriptsDir = Split-Path -Parent $PSScriptRoot
$script:NightlyScript = Join-Path $script:ScriptsDir 'nightly-ingest.ps1'
$script:PsLib = Join-Path $script:ScriptsDir 'lib\machine-env.ps1'
$script:ShLib = Join-Path $script:ScriptsDir 'lib\machine-env.sh'
# Windows PowerShell 5.1 is the target the scheduled task runs under.
$script:ChildShell = Join-Path $PSHOME 'powershell.exe'

$script:Failures = 0
$script:ScratchRoot = Join-Path $env:TEMP ("nightly-ingest-" + [guid]::NewGuid())

# Every variable a case may set, saved here and put back in `finally`.
$script:TouchedVariables = @('HARNESS_MACHINE_ENV', 'FAKE_INGEST_CODE', 'FAKE_VERIFY_CODE', 'FAKE_EVAL_CODE')
$script:SavedEnvironment = @{}
foreach ($name in $script:TouchedVariables) { $script:SavedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }

# uv is called as `uv --directory <project> run ingest <args>`, so %5 is the
# subcommand (or --source for the ingest itself). Labels, not parenthesised
# blocks: an echo holding `(s)` would end a cmd block early.
$script:FakeUv = @(
    '@echo off'
    'if not defined FAKE_INGEST_CODE set FAKE_INGEST_CODE=0'
    'if not defined FAKE_VERIFY_CODE set FAKE_VERIFY_CODE=0'
    'if not defined FAKE_EVAL_CODE set FAKE_EVAL_CODE=0'
    'echo FAKE-UV %*'
    'if "%~5"=="verify" goto verify'
    'if "%~5"=="eval" goto eval'
    'if "%~5"=="--source" exit /b %FAKE_INGEST_CODE%'
    'exit /b 0'
    ':verify'
    'echo verify: clean'
    'exit /b %FAKE_VERIFY_CODE%'
    ':eval'
    'exit /b %FAKE_EVAL_CODE%'
) -join "`r`n"

$script:FakeNode = @(
    '@echo off'
    'echo FAKE-NODE %*'
    'exit /b 0'
) -join "`r`n"

function New-ScratchDir {
    param([string] $Name)
    $path = Join-Path $script:ScratchRoot $Name
    [void] [System.IO.Directory]::CreateDirectory($path)
    return $path
}

# The folders and fakes every run shares. The vault name holds a space, so an
# argument built as a string instead of an array would show up split.
function New-Fixture {
    $fakeBin = New-ScratchDir 'fake-bin'
    [System.IO.File]::WriteAllText((Join-Path $fakeBin 'uv.cmd'), "$($script:FakeUv)`r`n", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText((Join-Path $fakeBin 'node.cmd'), "$($script:FakeNode)`r`n", [System.Text.Encoding]::ASCII)
    $project = New-ScratchDir 'project'
    [System.IO.File]::WriteAllText((Join-Path $project 'pyproject.toml'), '')
    $hooks = New-ScratchDir 'hooks'
    foreach ($name in @('sync-realms.mjs', 'sweep-transcripts.mjs', 'collect-checkpoints.mjs')) {
        [System.IO.File]::WriteAllText((Join-Path $hooks $name), '')
    }
    return [pscustomobject]@{
        Uv = Join-Path $fakeBin 'uv.cmd'
        Node = Join-Path $fakeBin 'node.cmd'
        Project = $project
        Hooks = $hooks
        Vault = New-ScratchDir 'my vault'
    }
}

# One run of the script in a child shell. Returns its exit code and its log.
function Invoke-Nightly {
    param($Fixture, [string] $Name, [string[]] $ExtraArgs = @(), [hashtable] $Environment = @{})
    $logPath = Join-Path $script:ScratchRoot "$Name.log"
    $scriptArgs = @(
        '-VaultPath', $Fixture.Vault, '-ProjectDir', $Fixture.Project, '-HooksDir', $Fixture.Hooks,
        '-UvPath', $Fixture.Uv, '-NodePath', $Fixture.Node, '-LogPath', $logPath) + $ExtraArgs
    foreach ($name in @('FAKE_INGEST_CODE', 'FAKE_VERIFY_CODE', 'FAKE_EVAL_CODE')) {
        [Environment]::SetEnvironmentVariable($name, $Environment[$name])
    }
    [Environment]::SetEnvironmentVariable('HARNESS_MACHINE_ENV', (Join-Path $script:ScratchRoot 'absent.env'))

    $ErrorActionPreference = 'Continue'
    $output = @(& $script:ChildShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:NightlyScript @scriptArgs 2>&1)
    $code = $LASTEXITCODE
    $log = if (Test-Path -LiteralPath $logPath) { @(Get-Content -LiteralPath $logPath -Encoding UTF8) } else { @() }
    return [pscustomobject]@{ Code = $code; Log = $log; Output = (($output | ForEach-Object { "$_" }) -join "`n") }
}

function Test-Check {
    param([string] $Name, [bool] $Ok, [string] $Detail = '')
    if ($Ok) { Write-Output "PASS $Name"; return }
    $script:Failures++
    Write-Output "FAIL $Name$(if ($Detail) { " -- $Detail" })"
}

# The index of the first log line holding $Text, or -1.
function Get-LineIndex {
    param([string[]] $Log, [string] $Text)
    for ($i = 0; $i -lt $Log.Count; $i++) { if ($Log[$i].Contains($Text)) { return $i } }
    return -1
}

function Test-LogHas {
    param([string[]] $Log, [string] $Text)
    return (Get-LineIndex $Log $Text) -ge 0
}

# The un-prefixed setting names each reader accepts, sorted, as one string.
function Get-SettingLists {
    $psText = Get-Content -LiteralPath $script:PsLib -Raw
    $shText = Get-Content -LiteralPath $script:ShLib -Raw
    $psMatch = [regex]::Match($psText, '\$settings\s*=\s*@\(([^)]*)\)')
    $shMatch = [regex]::Match($shText, "MACHINE_ENV_SETTINGS='([^']*)'")
    if (-not $psMatch.Success) { throw "no `$settings list in $script:PsLib" }
    if (-not $shMatch.Success) { throw "no MACHINE_ENV_SETTINGS in $script:ShLib" }
    $psNames = @($psMatch.Groups[1].Value -split ',' | ForEach-Object { $_.Trim().Trim("'") } | Where-Object { $_ } | Sort-Object)
    $shNames = @($shMatch.Groups[1].Value -split '\s+' | Where-Object { $_ } | Sort-Object)
    return [pscustomobject]@{ Ps = ($psNames -join ' '); Sh = ($shNames -join ' ') }
}

try {
    if (-not (Test-Path -LiteralPath $script:NightlyScript)) { throw "nightly-ingest.ps1 not found at $script:NightlyScript" }
    [void] [System.IO.Directory]::CreateDirectory($script:ScratchRoot)

    # (1) static: the script parses, ends on the exit-code rule, and its header names the steps.
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:NightlyScript, [ref] $null, [ref] $parseErrors)
    Test-Check 'the script parses with no errors' (@($parseErrors).Count -eq 0) (($parseErrors | ForEach-Object { $_.Message }) -join '; ')
    $lastStatement = $ast.EndBlock.Statements[$ast.EndBlock.Statements.Count - 1].Extent.Text
    Test-Check 'the last statement is still `exit $ingestCode`' ($lastStatement -ceq 'exit $ingestCode') "got '$lastStatement'"
    $header = "$($ast.GetHelpContent().Description)"
    Test-Check "the header's step list names verify as step 3" ($header -match '(?m)^\s*3\.\s+verify\b') $header
    Test-Check "the header's step list names eval as step 4" ($header -match '(?m)^\s*4\.\s+eval\b') $header
    $parameters = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    Test-Check 'the script takes -Verify and -Eval' (($parameters -contains 'Verify') -and ($parameters -contains 'Eval')) ($parameters -join ', ')

    # (2) the two machine-env readers accept exactly the same un-prefixed settings.
    $lists = Get-SettingLists
    Test-Check 'lib/machine-env.ps1 and .sh list the same settings' ($lists.Ps -ceq $lists.Sh) "ps1 '$($lists.Ps)' vs sh '$($lists.Sh)'"
    Test-Check 'the settings include STORE_VERIFY and RETRIEVAL_EVAL' (($lists.Ps -split ' ') -contains 'STORE_VERIFY' -and ($lists.Ps -split ' ') -contains 'RETRIEVAL_EVAL') $lists.Ps

    $fixture = New-Fixture

    # (3) a clean night: verify and eval run after the ingest and before the realm push.
    $r = Invoke-Nightly $fixture 'clean'
    Test-Check 'pruning is disabled without explicit opt-in' (-not (($r.Log -join "`n") -match '(?m)^.*ingest : .* --prune'))
    $ingestAt = Get-LineIndex $r.Log 'ingest : exit '
    $verifyAt = Get-LineIndex $r.Log 'verify : uv run ingest verify'
    $evalAt = Get-LineIndex $r.Log 'eval : uv run ingest eval'
    $pushAt = Get-LineIndex $r.Log 'realms-push : node'
    Test-Check "a clean night exits 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Output
    Test-Check 'verify is called with the vault path' (Test-LogHas $r.Log "verify : uv run ingest verify --path $($fixture.Vault)") ($r.Log -join "`n")
    Test-Check 'eval is called with --history' (Test-LogHas $r.Log 'eval : uv run ingest eval --history')
    Test-Check "verify's own output reaches the log" (Test-LogHas $r.Log 'verify | verify: clean')
    Test-Check 'the order is ingest, verify, eval, realms-push' ($ingestAt -ge 0 -and $ingestAt -lt $verifyAt -and $verifyAt -lt $evalAt -and $evalAt -lt $pushAt) "ingest $ingestAt, verify $verifyAt, eval $evalAt, push $pushAt"
    Test-Check 'the summary line reports verify and eval after ingest' (Test-LogHas $r.Log 'ingest 0, verify 0, eval 0, realms-push 0) ===')
    Test-Check 'a clean night logs no "ended with"' (-not (Test-LogHas $r.Log 'ended with'))
    $r = Invoke-Nightly $fixture 'prune-opt-in' -ExtraArgs @('-Prune')
    Test-Check 'pruning requires explicit opt-in' (Test-LogHas $r.Log '--prune')

    # (4) verify and eval failing are logged and change nothing about the exit code.
    $r = Invoke-Nightly $fixture 'steps-fail' -Environment @{ FAKE_VERIFY_CODE = '1'; FAKE_EVAL_CODE = '2' }
    Test-Check "failing verify and eval still exit 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Output
    Test-Check 'a verify failure is logged' (Test-LogHas $r.Log 'verify ended with 1;') ($r.Log -join "`n")
    Test-Check 'an eval failure is logged' (Test-LogHas $r.Log 'eval ended with 2;')
    Test-Check 'the realm push still runs after them' (Test-LogHas $r.Log 'realms-push : exit 0')
    Test-Check 'the summary line carries their codes' (Test-LogHas $r.Log 'ingest 0, verify 1, eval 2, realms-push 0) ===')

    # (5) the exit code is still the ingest's, and verify and eval still run after a failed ingest.
    $r = Invoke-Nightly $fixture 'ingest-fails' -Environment @{ FAKE_INGEST_CODE = '1' }
    Test-Check "a failed ingest exits 1 (exit $($r.Code))" ($r.Code -eq 1) $r.Output
    Test-Check 'verify and eval still run after a failed ingest' ((Test-LogHas $r.Log 'verify : exit 0') -and (Test-LogHas $r.Log 'eval : exit 0'))

    # (6) -Verify Skip and -Eval Skip switch the steps off without touching uv.
    $r = Invoke-Nightly $fixture 'skip' -ExtraArgs @('-Verify', 'Skip', '-Eval', 'Skip')
    Test-Check "a skipped night exits 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Output
    Test-Check '-Verify Skip is logged and verify does not run' ((Test-LogHas $r.Log 'verify: skipped by -Verify Skip') -and -not (Test-LogHas $r.Log 'uv run ingest verify'))
    Test-Check '-Eval Skip is logged and eval does not run' ((Test-LogHas $r.Log 'eval: skipped by -Eval Skip') -and -not (Test-LogHas $r.Log 'uv run ingest eval'))
    Test-Check 'the summary line reports skipped steps as 0' (Test-LogHas $r.Log 'verify 0, eval 0')

    # (7) -EnvFile reaches verify and eval, as it reaches the ingest.
    $envFile = Join-Path $script:ScratchRoot 'store.env'
    $r = Invoke-Nightly $fixture 'env-file' -ExtraArgs @('-EnvFile', $envFile)
    Test-Check 'verify gets --env-file' (Test-LogHas $r.Log "verify : uv run ingest verify --path $($fixture.Vault) --env-file $envFile") ($r.Log -join "`n")
    Test-Check 'eval gets --env-file' (Test-LogHas $r.Log "eval : uv run ingest eval --history --env-file $envFile")

    # (8) a value outside the set is refused before anything runs.
    $r = Invoke-Nightly $fixture 'bad-value' -ExtraArgs @('-Verify', 'DryRun')
    Test-Check "-Verify DryRun is refused (exit $($r.Code))" ($r.Code -ne 0 -and $r.Log.Count -eq 0) $r.Output
} catch {
    $script:Failures++
    Write-Output "FAIL harness -- $($_.Exception.Message)"
} finally {
    foreach ($name in $script:TouchedVariables) { [Environment]::SetEnvironmentVariable($name, $script:SavedEnvironment[$name]) }
    if (Test-Path -LiteralPath $script:ScratchRoot) {
        try {
            Remove-Item -LiteralPath $script:ScratchRoot -Recurse -Force
        } catch {
            Write-Output "warning: could not remove $script:ScratchRoot -- $($_.Exception.Message)"
        }
    }
}

if ($script:Failures -gt 0) {
    Write-Output "$($script:Failures) case(s) failed."
    exit 1
}
Write-Output 'All cases passed.'
exit 0
