#!/usr/bin/env python3
"""Install a per-user launchd worker for the Codex capture queue (macOS)."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Install and start; default is dry run')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This installer requires macOS')
    node = shutil.which('node')
    if not node:
        parser.error('Node must be on PATH')
    node = str(Path(node).resolve())
    home = Path.home()
    repo = Path(__file__).resolve().parents[1]
    label = 'com.agentic-harness.codex-ingest'
    target = home / 'Library/LaunchAgents' / (label + '.plist')
    logs = home / '.codex/hooks'
    spec = {
        'Label': label,
        'ProgramArguments': [node, str(repo / 'hooks/codex-ingest-queue.mjs')],
        'WorkingDirectory': str(repo),
        'RunAtLoad': True,
        'StartInterval': 300,
        'ProcessType': 'Background',
        'EnvironmentVariables': {
            'PATH': ':'.join([str(Path(node).parent), str(home / '.local/bin'),
                              '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
            'HOME': str(home),
            'HARNESS_CODEX_CADENCE': '1',
        },
        'StandardOutPath': str(logs / 'codex-worker.stdout.log'),
        'StandardErrorPath': str(logs / 'codex-worker.stderr.log'),
    }
    if not args.apply:
        print(plistlib.dumps(spec).decode())
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    domain = 'gui/' + str(os.getuid())
    if target.exists():
        shutil.copy2(target, target.with_suffix('.plist.backup'))
        subprocess.run(['launchctl', 'bootout', domain, str(target)], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    target.write_bytes(plistlib.dumps(spec))
    subprocess.run(['plutil', '-lint', str(target)], check=True)
    subprocess.run(['launchctl', 'bootstrap', domain, str(target)], check=True)
    print('Installed:', target)


if __name__ == '__main__':
    main()
