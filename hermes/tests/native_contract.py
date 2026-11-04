"""Opt-in integration smoke using the installed Hermes ABC and configuration writer.

All writes go to a newly created temporary profile. No model/API calls or user history.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
args = parser.parse_args()
source = Path(args.source).resolve()
repo = Path(__file__).parents[2]
with tempfile.TemporaryDirectory(prefix='harness-hermes-native-') as temporary:
    home = Path(temporary)
    os.environ['HERMES_HOME'] = str(home)
    os.environ['HERMES_RUNTIME_DIR'] = str(home / 'runtime')
    sys.path.insert(0, str(source))
    plugin = home / 'plugins' / 'harness-memory'
    shutil.copytree(repo / 'hermes' / 'harness-memory', plugin)
    (home / 'harness-memory.json').write_text(json.dumps({'enabled': True, 'repo': str(repo), 'node': 'node'}), encoding='utf-8')
    from agent.memory_provider import MemoryProvider
    from plugins.memory import load_memory_provider
    provider = load_memory_provider('harness-memory')
    assert isinstance(provider, MemoryProvider), 'native discovery did not load our provider'
    assert provider.is_available(), 'native provider did not read profile sidecar'
    activation = importlib.util.spec_from_file_location('harness_activation', repo / 'hermes' / 'activate.py')
    module = importlib.util.module_from_spec(activation)
    activation.loader.exec_module(module)
    preview = module.activate_provider(hermes_home=home, source=source)
    assert preview['previous_provider'] == 'builtin'
    applied = module.activate_provider(hermes_home=home, source=source, apply=True)
    assert applied['applied'] is True
    from hermes_cli.config import load_config_readonly
    assert load_config_readonly()['memory']['provider'] == 'harness-memory'
    print(json.dumps({'native_discovery': True, 'abc_contract': True, 'native_configuration': True, 'user_history_read': False, 'model_calls': 0}))
