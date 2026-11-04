"""Select the installed adapter through Hermes's native configuration writer.

Default is preview-only. Run with the owning Hermes Python and an explicit home.
Only memory.provider is changed; the native writer merges other settings.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys


def activate_provider(*, hermes_home, source=None, apply=False, expected_provider='builtin'):
    home = Path(hermes_home).resolve()
    if source:
        sys.path.insert(0, str(Path(source).resolve()))
    os.environ['HERMES_HOME'] = str(home)
    from hermes_cli.config import load_config_readonly, save_config
    config = load_config_readonly()
    previous = str(config.get('memory', {}).get('provider') or 'builtin')
    if previous not in (expected_provider, 'harness-memory'):
        raise ValueError('active memory provider changed; review before selecting another provider')
    result = {'previous_provider': previous, 'provider': 'harness-memory', 'applied': False}
    if not apply or previous == 'harness-memory':
        return result
    if not (home / 'plugins' / 'harness-memory' / '__init__.py').is_file() or not (home / 'harness-memory.json').is_file():
        raise ValueError('install the adapter and sidecar before activation')
    file = home / 'config.yaml'
    if file.exists():
        directory = home / 'backups'
        directory.mkdir(parents=True, exist_ok=True)
        backup = directory / ('harness-memory-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.config.yaml')
        with backup.open('xb') as output:
            output.write(file.read_bytes())
        result['backup'] = str(backup)
    save_config({'memory': {'provider': 'harness-memory'}}, merge_existing=True)
    if load_config_readonly().get('memory', {}).get('provider') != 'harness-memory':
        raise RuntimeError('native configuration writer did not activate the provider')
    result['applied'] = True
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', required=True)
    parser.add_argument('--source')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--expected-provider', default='builtin')
    args = parser.parse_args()
    print(json.dumps(activate_provider(hermes_home=args.home, source=args.source, apply=args.apply, expected_provider=args.expected_provider)))
