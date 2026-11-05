#!/usr/bin/env python3
"""Install a per-user launchd job that pushes this Mac's vault realms once a day (macOS).

The five-minute worker (``register-codex-ingest-macos.py``) captures sessions and
indexes them, but nothing on a Mac pushes the realms to GitHub unless someone runs
``node hooks/sync-realms.mjs --push`` by hand. This installs a LaunchAgent that
runs exactly that every day at a local time (03:30 by default): commit the sync
paths, merge-pull, push every realm whose policy is ``push``. The job runs in the
user's GUI session, so git's osxkeychain credential helper serves the push the
same way it does in Terminal; the sync never prompts, so a missing credential
fails fast and shows in the log. launchd runs a calendar job it missed while the
Mac slept as soon as it wakes.

    python3 scripts/register-realm-sync-macos.py            # dry run: prints the plist
    python3 scripts/register-realm-sync-macos.py --apply    # install (or replace) and load
    python3 scripts/register-realm-sync-macos.py --hour 4 --minute 0 --apply

Logs: ``~/.harness/realm-sync.stdout.log`` and ``realm-sync.stderr.log``. Exit code
2 in the log means a realm needs a person (a conflict, a refused path, a lock);
``launchctl print gui/$(id -u)/com.agentic-harness.realm-sync`` shows the last run.
"""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

LABEL = 'com.agentic-harness.realm-sync'
DEFAULT_HOUR = 3
DEFAULT_MINUTE = 30


def build_spec(node: Path, home: Path, repo: Path, hour: int, minute: int) -> dict:
    """The LaunchAgent definition; pure, so a dry run and a test can see it."""
    logs = home / '.harness'
    return {
        'Label': LABEL,
        'ProgramArguments': [str(node), str(repo / 'hooks/sync-realms.mjs'), '--push'],
        'WorkingDirectory': str(repo),
        'RunAtLoad': False,
        'StartCalendarInterval': {'Hour': hour, 'Minute': minute},
        'ProcessType': 'Background',
        'EnvironmentVariables': {
            'PATH': ':'.join([str(node.parent), str(home / '.local/bin'),
                              '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
            'HOME': str(home),
        },
        'StandardOutPath': str(logs / 'realm-sync.stdout.log'),
        'StandardErrorPath': str(logs / 'realm-sync.stderr.log'),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--apply', action='store_true', help='Install and load; default is dry run')
    parser.add_argument('--hour', type=int, default=DEFAULT_HOUR, help='local hour, 0-23 (default %(default)s)')
    parser.add_argument('--minute', type=int, default=DEFAULT_MINUTE, help='local minute, 0-59 (default %(default)s)')
    args = parser.parse_args()
    if not 0 <= args.hour <= 23 or not 0 <= args.minute <= 59:
        parser.error('--hour must be 0-23 and --minute 0-59')
    if sys.platform != 'darwin':
        parser.error('This installer requires macOS')
    node = shutil.which('node')
    if not node:
        parser.error('Node must be on PATH')
    node = Path(node).resolve()
    home = Path.home()
    repo = Path(__file__).resolve().parents[1]
    spec = build_spec(node, home, repo, args.hour, args.minute)
    target = home / 'Library/LaunchAgents' / (LABEL + '.plist')
    if not args.apply:
        print(plistlib.dumps(spec).decode())
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    (home / '.harness').mkdir(parents=True, exist_ok=True)
    domain = 'gui/' + str(os.getuid())
    if target.exists():
        shutil.copy2(target, target.with_suffix('.plist.backup'))
        subprocess.run(['launchctl', 'bootout', domain, str(target)], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    target.write_bytes(plistlib.dumps(spec))
    subprocess.run(['plutil', '-lint', str(target)], check=True)
    subprocess.run(['launchctl', 'bootstrap', domain, str(target)], check=True)
    print('Installed:', target)
    print(f'Runs daily at {args.hour:02d}:{args.minute:02d} local; '
          f'run it now with: launchctl kickstart -k {domain}/{LABEL}')


if __name__ == '__main__':
    main()
