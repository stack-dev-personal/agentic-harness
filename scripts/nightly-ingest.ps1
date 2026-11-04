<#
.SYNOPSIS
    The nightly reconcile: conclude stale sessions, re-ingest the vault, then
    audit the store and score retrieval.

.DESCRIPTION
    The steps, in this order and for this reason:

      0. transcript sweep — hooks/sweep-transcripts.mjs writes a note for every
         idle transcript under ~/.claude/projects that has none: SDK workers,
         sessions killed with their terminal, teleported cloud sessions.
      0a. state sweep    — hooks/sweep-state.mjs removes SessionStart records
         (~/.harness/state/session-start/*.json) older than a week. Capture
         reads them and deletes nothing, so this is what keeps the folder small.
      0b. checkpoints    — hooks/collect-checkpoints.mjs fetches the notes the
         /checkpoint skill pushed from cloud sessions and files them in the vault.
      1. sweep-concluded  — sets status: concluded and concluded_at on session
         notes still 'active' more than 24 h after their ended_at (R-27.2).
      2. ingest           — a full walk of the vault, which picks up the notes
         the sweeps just wrote along with anything the per-note hook missed.
      3. verify           — `ingest verify`, the read-only store audit (R-Q1):
         exit 0 clean, 1 findings, 2 could not run. After the ingest, so it
         audits the store the ingest just left.
      4. eval             — `ingest eval --history`, the read-only retrieval
         eval (R-Q3), which appends one line to ingest/eval/history.jsonl.
      5. realms-push      — commit, merge-pull and push the push-policy realms.

    Verify and eval only report. A non-zero exit from either is logged and the
    job goes on; neither changes the exit code, which stays the ingest's.

    Running the sweep first is what makes the status change visible to search in
    the same night. The other way round, every concluded note would wait a day.

    The sweep touches frontmatter only, and content_hash is over the body, so
    the ingest reaches those notes through its metadata-only path: it compares
    the stored title and metadata with the freshly parsed ones and issues one
    UPDATE, with no re-chunking and no embedding. They are counted in the run
    summary as 'metadata-updated'.

    A complete ingest writes its own last-success timestamp, which is what
    `ingest --health` reads. This script does not write that file; a run that
    fails must not look like a run that worked.

    Registered by register-nightly-ingest.ps1. Safe to run by hand.

.PARAMETER VaultPath
    The Obsidian vault. Must be a Windows path (C:/...), not an MSYS /c/... one.

.PARAMETER ProjectDir
    The uv project holding the ingest package (the directory with pyproject.toml).

.PARAMETER SweepMode
    Apply   - write the concluded status (the point of the nightly run)
    DryRun  - report what it would conclude, change nothing
    Skip    - do not sweep at all

.PARAMETER Verify
    Apply   - run the store audit after the ingest (the default)
    Skip    - do not audit. It never writes, so there is no DryRun.

.PARAMETER Eval
    Apply   - run the retrieval eval and append to its history (the default)
    Skip    - do not score retrieval tonight

.PARAMETER StateSweep
    Apply   - remove session-start records older than -StateMaxAgeDays
    DryRun  - list what it would remove, remove nothing
    Skip    - do not sweep the state folder

.PARAMETER StateMaxAgeDays
    Age in days past which a session-start record is removed (default 7).

.EXAMPLE
    ./nightly-ingest.ps1 -SweepMode DryRun
#>
[CmdletBinding()]
param(
    [string] $VaultPath = '',
    [string] $ProjectDir = '',
    [string] $UvPath = '',
    [string] $LogPath = "C:/Users/$env:USERNAME/.claude/hooks/nightly-ingest.log",
    [ValidateSet('Apply', 'DryRun', 'Skip')]
    [string] $SweepMode = 'Apply',
    [ValidateRange(1, 8760)]
    [int] $StaleAfterHours = 24,
    [string] $EnvFile = '',
    # Step 0: the transcript sweep (hooks/sweep-transcripts.mjs), which writes a
    # note for every idle transcript the SessionEnd hook never saw.
    [string] $HooksDir = '',
    [string] $NodePath = '',
    [ValidateSet('Apply', 'DryRun', 'Skip')]
    [string] $TranscriptSweep = 'Apply',
    [ValidateRange(0, 8760)]
    [int] $TranscriptIdleHours = 6,
    # Step 0a: the SessionStart records under ~/.harness/state/session-start
    # (hooks/sweep-state.mjs). Capture never deletes them; this does, after a week.
    [ValidateSet('Apply', 'DryRun', 'Skip')]
    [string] $StateSweep = 'Apply',
    [ValidateRange(1, 365)]
    [int] $StateMaxAgeDays = 7,
    # Step 0b: /checkpoint notes pushed by cloud sessions, collected out of git
    # (hooks/collect-checkpoints.mjs). Empty means the collector's own defaults.
    [string[]] $CheckpointRepos = @(),
    [ValidateSet('Apply', 'DryRun', 'Skip')]
    [string] $Checkpoints = 'Apply',
    # Steps -1 and 5 (hooks/sync-realms.mjs): commit and merge-pull every realm
    # before the night's work; commit, merge-pull and push the push-policy realms
    # after it. Nothing is forced, rebased or stashed.
    [ValidateSet('Apply', 'DryRun', 'Skip')]
    [string] $RealmSync = 'Apply',
    # Steps 3 and 4: the store audit (`ingest verify`) and the retrieval eval
    # (`ingest eval --history`). Both are read-only against the store, so Skip is
    # the only other choice.
    [ValidateSet('Apply', 'Skip')]
    [string] $Verify = 'Apply',
    [ValidateSet('Apply', 'Skip')]
    [string] $Eval = 'Apply',
    # Deleting orphan rows requires an explicit operator opt-in.
    [switch] $Prune
)

$ErrorActionPreference = 'Stop'

# node prints UTF-8. Without this, PowerShell 5.1 decodes captured child output as
# the OEM code page and `café.md` or `…` reach the log as mojibake.
# A run with no console handle cannot set it; the log is then only less readable,
# and says so once the logger exists (Write-Log is defined further down).
$encodingNote = ''
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { $encodingNote = "console output encoding not set ($($_.Exception.Message)); non-ASCII in child output may log as mojibake" }

# Keep one night's worth of detail without letting the file grow forever.
$LogMaxBytes = 1MB
$LogKeepLines = 2000

# ~/.harness/machine.env: what this machine is, through the shared reader
# (Read-MachineEnv, Get-MachineSetting). A parameter passed explicitly still
# wins; the file only replaces the defaults that used to name one machine's paths.
. (Join-Path $PSScriptRoot 'lib\machine-env.ps1')

$machine = Read-MachineEnv
if (-not $VaultPath)  { $VaultPath  = Get-MachineSetting $machine 'HARNESS_VAULT' "$($env:USERPROFILE -replace '\\', '/')/vault" }
if (-not $ProjectDir) { $ProjectDir = Get-MachineSetting $machine 'HARNESS_INGEST_PROJECT' "C:/Users/$env:USERNAME/agentic-harness/ingest" }
if (-not $HooksDir)   { $HooksDir   = Get-MachineSetting $machine 'HARNESS_HOOKS_DIR' "C:/Users/$env:USERNAME/agentic-harness/hooks" }
if (-not $NodePath)   { $NodePath   = Get-MachineSetting $machine 'HARNESS_NODE' '' }

function Write-Log {
    param([string] $Message)

    $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
    # Write-Host, not Write-Output: Write-Output emits into the PIPELINE, so
    # every log line inside Invoke-Ingest would become part of that function's
    # return value and the exit code would come back as an array of strings.
    Write-Host $line
    try {
        $directory = Split-Path -Parent $LogPath
        if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
        if (Test-Path $LogPath) {
            $existing = Get-Item $LogPath
            if ($existing.Length -gt $LogMaxBytes) {
                $kept = Get-Content $LogPath -Tail $LogKeepLines
                Set-Content -Path $LogPath -Value $kept -Encoding utf8
            }
        }
        Add-Content -Path $LogPath -Value $line -Encoding utf8
    } catch {
        # A log that cannot be written must not fail the job it is logging.
        Write-Host "(could not write $LogPath)"
    }
}

function Resolve-Uv {
    param([string] $Explicit)

    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "uv not found at $Explicit" }
        return $Explicit
    }

    $local = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (Test-Path $local) { return $local }

    $onPath = Get-Command uv -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    throw 'uv was not found. Pass -UvPath, or install it so uv.exe is on PATH.'
}

function Resolve-Node {
    # Explicit wins; then the machine file; then the standard install; then PATH.
    param([string] $Explicit)

    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "node not found at $Explicit" }
        return $Explicit
    }

    $standard = 'C:/Program Files/nodejs/node.exe'
    if (Test-Path $standard) { return $standard }

    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    throw 'node was not found. Pass -NodePath, or install it so node.exe is on PATH.'
}

function Invoke-TranscriptSweep {
    param([string] $Node, [string] $Script, [string[]] $SweepArgs, [string] $Label)

    Write-Log "$Label : node $(Split-Path -Leaf $Script) $($SweepArgs -join ' ')"

    # Same stderr handling as Invoke-Ingest: merge both streams into the log
    # without a NativeCommandError turning the first line into a fatal one.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Node $Script @SweepArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }

    foreach ($line in $output) { Write-Log "$Label | $line" }
    Write-Log "$Label : exit $code"
    return [int] $code
}

function Invoke-Ingest {
    param([string] $Uv, [string] $Project, [string[]] $IngestArgs, [string] $Label)

    Write-Log "$Label : uv run ingest $($IngestArgs -join ' ')"

    # `ingest` logs at INFO to STDERR, and so does `uv run`. In Windows
    # PowerShell 5.1, merging a native command's stderr into the pipeline while
    # $ErrorActionPreference is 'Stop' turns every one of those lines into a
    # terminating NativeCommandError — the nightly job would abort on its first
    # log line, every night, and the only symptom would be a non-zero exit.
    # Relaxing the preference for exactly this call keeps the merge (we want
    # both streams in the log) without the merge being fatal.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Argument array, never a command string: the vault path holds spaces.
        $output = & $Uv --directory $Project run ingest @IngestArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }

    foreach ($line in $output) { Write-Log "$Label | $line" }
    Write-Log "$Label : exit $code"

    # The ONLY thing this function puts on the pipeline. Everything above logs
    # through Write-Host for exactly that reason.
    return [int] $code
}

# --------------------------------------------------------------------------

Write-Log '=== nightly reconcile starting ==='
if ($encodingNote) { Write-Log $encodingNote }

if (-not (Test-Path $VaultPath)) {
    Write-Log "FATAL vault not found: $VaultPath"
    exit 2
}
if (-not (Test-Path (Join-Path $ProjectDir 'pyproject.toml'))) {
    Write-Log "FATAL no ingest project at $ProjectDir (expected pyproject.toml)"
    exit 2
}

try {
    $uv = Resolve-Uv -Explicit $UvPath
} catch {
    Write-Log "FATAL $($_.Exception.Message)"
    exit 2
}
Write-Log "uv: $uv"
Write-Log "vault: $VaultPath"
Write-Log "project: $ProjectDir"

$envArgs = @()
if ($EnvFile) { $envArgs = @('--env-file', $EnvFile) }

# Step 0: transcripts the hook never saw become notes now, so the ingest below
# embeds them tonight. Runs from the checkout, like the ingest project does.
# Step -1: commit and merge-pull every realm this machine holds, so the night's
# work starts from what the other machines pushed. A conflict is exit 2 and never
# fatal: the merge is aborted, the local commit is kept, and the rest of the night
# still runs. A realm locked by another run is exit 2 the same way.
function Invoke-RealmSync {
    param([string] $Mode, [string] $Label)
    if ($RealmSync -eq 'Skip') { Write-Log "$Label : skipped by -RealmSync Skip"; return 0 }
    $syncScript = Join-Path $HooksDir 'sync-realms.mjs'
    if (-not (Test-Path $syncScript)) { Write-Log "$Label : no sync script at $syncScript"; return 2 }
    try {
        $node = Resolve-Node -Explicit $NodePath
        $syncArgs = @("--$Mode", '--vault', $VaultPath)
        if ($RealmSync -eq 'DryRun') { $syncArgs += '--dry-run' }
        return Invoke-TranscriptSweep -Node $node -Script $syncScript -SweepArgs $syncArgs -Label $Label
    } catch {
        Write-Log "$Label : $($_.Exception.Message)"
        return 2
    }
}

$pullCode = Invoke-RealmSync -Mode 'pull' -Label 'realms-pull'
if ($pullCode -ne 0) { Write-Log "realm pull ended with $pullCode; continuing with what is on disk" }

$transcriptCode = 0
if ($TranscriptSweep -eq 'Skip') {
    Write-Log 'transcripts: skipped by -TranscriptSweep Skip'
} else {
    $sweepScript = Join-Path $HooksDir 'sweep-transcripts.mjs'
    if (-not (Test-Path $sweepScript)) {
        Write-Log "transcripts: no sweep script at $sweepScript; continuing to the ingest"
        $transcriptCode = 2
    } else {
        try {
            $node = Resolve-Node -Explicit $NodePath
            Write-Log "node: $node"
            $transcriptArgs = @('--vault', $VaultPath, '--min-idle-hours', "$TranscriptIdleHours")
            if ($TranscriptSweep -eq 'DryRun') { $transcriptArgs += '--dry-run' }
            $transcriptCode = Invoke-TranscriptSweep -Node $node -Script $sweepScript -SweepArgs $transcriptArgs -Label 'transcripts'
        } catch {
            Write-Log "transcripts: $($_.Exception.Message); continuing to the ingest"
            $transcriptCode = 2
        }
    }
}
if ($transcriptCode -ne 0) { Write-Log "transcript sweep failed with $transcriptCode; continuing to the ingest" }

# Step 0a: session-start records older than a week. Same runner as step 0;
# a failure is logged and never fatal, and a missing folder is exit 0.
$stateCode = 0
if ($StateSweep -eq 'Skip') {
    Write-Log 'state: skipped by -StateSweep Skip'
} else {
    $stateScript = Join-Path $HooksDir 'sweep-state.mjs'
    if (-not (Test-Path $stateScript)) {
        Write-Log "state: no sweep script at $stateScript; continuing to the ingest"
        $stateCode = 2
    } else {
        try {
            $node = Resolve-Node -Explicit $NodePath
            $stateArgs = @('--max-age-days', "$StateMaxAgeDays")
            if ($StateSweep -eq 'DryRun') { $stateArgs += '--dry-run' }
            $stateCode = Invoke-TranscriptSweep -Node $node -Script $stateScript -SweepArgs $stateArgs -Label 'state'
        } catch {
            Write-Log "state: $($_.Exception.Message); continuing to the ingest"
            $stateCode = 2
        }
    }
}
if ($stateCode -ne 0) { Write-Log "state sweep failed with $stateCode; continuing to the ingest" }

# Step 0b: notes the /checkpoint skill pushed from cloud sessions. Same
# runner as step 0; a refused note or a failed fetch is exit 1, never fatal.
$checkpointCode = 0
if ($Checkpoints -eq 'Skip') {
    Write-Log 'checkpoints: skipped by -Checkpoints Skip'
} else {
    $collectScript = Join-Path $HooksDir 'collect-checkpoints.mjs'
    if (-not (Test-Path $collectScript)) {
        Write-Log "checkpoints: no collector at $collectScript; continuing to the ingest"
        $checkpointCode = 2
    } else {
        try {
            $node = Resolve-Node -Explicit $NodePath
            $collectArgs = @('--vault', $VaultPath)
            foreach ($repo in $CheckpointRepos) { $collectArgs += @('--repo', $repo) }
            if ($Checkpoints -eq 'DryRun') { $collectArgs += '--dry-run' }
            $checkpointCode = Invoke-TranscriptSweep -Node $node -Script $collectScript -SweepArgs $collectArgs -Label 'checkpoints'
        } catch {
            Write-Log "checkpoints: $($_.Exception.Message); continuing to the ingest"
            $checkpointCode = 2
        }
    }
}
if ($checkpointCode -ne 0) { Write-Log "checkpoint collection ended with $checkpointCode; continuing to the ingest" }

$sweepCode = 0
if ($SweepMode -eq 'Skip') {
    Write-Log 'sweep: skipped by -SweepMode Skip'
} else {
    $sweepArgs = @('sweep-concluded', '--path', $VaultPath, '--stale-after-hours', "$StaleAfterHours")
    if ($SweepMode -eq 'Apply') { $sweepArgs += '--apply' } else { $sweepArgs += '--dry-run' }
    $sweepCode = Invoke-Ingest -Uv $uv -Project $ProjectDir -IngestArgs $sweepArgs -Label 'sweep'
}

# The sweep failing is not a reason to skip the reconcile: the vault still needs
# re-ingesting, and a stale status is a smaller problem than a stale index.
if ($sweepCode -ne 0) { Write-Log "sweep failed with $sweepCode; continuing to the ingest" }

# --prune drops rows whose note left the vault or stopped qualifying for the
# index (an SDK worker session, a note newly marked ingest: false). It refuses on
# its own after any failed document or an empty load, so a bad night deletes nothing.
$ingestArgs = @('--source', 'obsidian', '--path', $VaultPath) + $envArgs
if ($Prune) { $ingestArgs += '--prune' }
$ingestCode = Invoke-Ingest -Uv $uv -Project $ProjectDir -IngestArgs $ingestArgs -Label 'ingest'

# Step 3: audit the store the ingest just left. It runs after a failed ingest
# too: that is the night its findings matter most, and it only reads.
$verifyCode = 0
if ($Verify -eq 'Skip') {
    Write-Log 'verify: skipped by -Verify Skip'
} else {
    $verifyArgs = @('verify', '--path', $VaultPath) + $envArgs
    $verifyCode = Invoke-Ingest -Uv $uv -Project $ProjectDir -IngestArgs $verifyArgs -Label 'verify'
}
if ($verifyCode -ne 0) { Write-Log "verify ended with $verifyCode; 1 is findings, 2 is could not run, see the verify lines above" }

# Step 4: score retrieval against the golden set and append the result to
# ingest/eval/history.jsonl. No --min-hit-rate, so it reports and never gates.
$evalCode = 0
if ($Eval -eq 'Skip') {
    Write-Log 'eval: skipped by -Eval Skip'
} else {
    $evalArgs = @('eval', '--history') + $envArgs
    $evalCode = Invoke-Ingest -Uv $uv -Project $ProjectDir -IngestArgs $evalArgs -Label 'eval'
}
if ($evalCode -ne 0) { Write-Log "eval ended with $evalCode; tonight's history line may be missing, see the eval lines above" }

# Step 5: commit the night's notes, merge-pull, and push the realms whose policy
# allows it. Last, so a machine that fails earlier pushes nothing half-reconciled.
# A conflicting merge is aborted with the local commit kept; it pushes next time.
$pushCode = Invoke-RealmSync -Mode 'push' -Label 'realms-push'
if ($pushCode -ne 0) { Write-Log "realm push ended with $pushCode; the notes are on disk and will go next time" }

Write-Log "=== nightly reconcile finished (realms-pull $pullCode, transcripts $transcriptCode, state $stateCode, checkpoints $checkpointCode, sweep $sweepCode, ingest $ingestCode, verify $verifyCode, eval $evalCode, realms-push $pushCode) ==="

# Task Scheduler shows this as the last result, so it has to mean "the reconcile
# worked". Only the ingest decides that: verify and eval report through the log
# and never change this code, however they end.
exit $ingestCode
