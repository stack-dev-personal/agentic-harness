"""Synthetic contract tests. No live Hermes state, credentials, or models."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import sqlite3
import types
import unittest
from unittest import mock

agent = types.ModuleType('agent')
memory = types.ModuleType('agent.memory_provider')
memory.MemoryProvider = object
memory.spawn_context_thread = lambda target, **kwargs: types.SimpleNamespace(start=target, join=lambda timeout: None)
sys.modules.setdefault('agent', agent)
sys.modules.setdefault('agent.memory_provider', memory)

file = Path(__file__).parents[1] / 'harness-memory' / '__init__.py'
spec = importlib.util.spec_from_file_location('harness_memory', file)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.calls = []

    def bridge(self, request):
        self.calls.append(request)
        if request['operation'] == 'policy': return {'allowed': True}
        if request['operation'] == 'brief': return {'context': 'Shared startup brief.'}
        if request['operation'] == 'tools': return {'tools': [{'name': 'search_context', 'description': 'Shared search', 'inputSchema': {'type': 'object'}}]}
        if request['operation'] == 'call': return {'content': [{'type': 'text', 'text': 'Same shared result.'}]}
        return {'written': True}

    def provider(self, bridge=None):
        return module.HarnessMemoryProvider(bridge=bridge or self.bridge, config_loader=lambda home: {'enabled': True, 'repo': str(self.home), 'node': 'node'})

    def test_start_brief_and_tools_use_shared_bridge_without_private_retrieval_rules(self):
        provider = self.provider()
        provider.initialize('s1', hermes_home=str(self.home), cwd='C:/work/demo')
        self.assertEqual(provider.prefetch('A meaningful question'), 'Shared startup brief.')
        self.assertEqual(provider.prefetch('Another question'), '')
        self.assertEqual(provider.get_tool_schemas()[0]['name'], 'search_context')
        result = json.loads(provider.handle_tool_call('search_context', {'query': 'invariant'}))
        self.assertEqual(result['content'][0]['text'], 'Same shared result.')
        self.assertEqual(self.calls[-1]['arguments'], {'query': 'invariant'})

    def test_turn_checkpoint_and_actual_session_end_have_distinct_lifecycle(self):
        provider = self.provider()
        provider.initialize('s1', hermes_home=str(self.home), cwd='C:/work/demo')
        messages = [{'role': 'user', 'content': 'Question'}, {'role': 'assistant', 'content': 'Answer'}]
        provider.sync_turn('Question', 'Answer', session_id='s1', messages=messages)
        provider.on_session_end(messages)
        snapshots = [r['snapshot'] for r in self.calls if r['operation'] == 'capture']
        self.assertEqual([s['concluded'] for s in snapshots], [False, True])
        self.assertTrue((self.home / 'state' / 'harness-memory-sessions.json').exists())
        registry = json.loads((self.home / 'state' / 'harness-memory-sessions.json').read_text())
        self.assertNotIn('Question', json.dumps(registry))

    def test_first_registration_timestamp_survives_session_resumes(self):
        provider = self.provider()
        with mock.patch.object(module.time, 'time', return_value=1000.0):
            provider.initialize('s1', hermes_home=str(self.home), cwd=str(self.home))
        with mock.patch.object(module.time, 'time', return_value=2000.0):
            provider.initialize('s1', hermes_home=str(self.home), cwd=str(self.home))
        registry = json.loads((self.home / 'state' / 'harness-memory-sessions.json').read_text())
        self.assertEqual(registry['sessions']['s1']['registered_at'], 1000.0)

    def test_legacy_or_invalid_registration_timestamp_starts_at_current_activation(self):
        directory = self.home / 'state'
        directory.mkdir()
        file = directory / 'harness-memory-sessions.json'
        for existing in [None, 'invalid', -1, True, float('nan'), float('inf')]:
            with self.subTest(existing=existing):
                record = {'cwd': str(self.home)}
                if existing is not None:
                    record['registered_at'] = existing
                file.write_text(json.dumps({'sessions': {'s1': record}}), encoding='utf-8')
                with mock.patch.object(module.time, 'time', return_value=3000.0):
                    self.provider().initialize('s1', hermes_home=str(self.home), cwd=str(self.home))
                registry = json.loads(file.read_text())
                self.assertEqual(registry['sessions']['s1']['registered_at'], 3000.0)

    def test_exclusion_stops_registration_capture_and_recall(self):
        def deny(request):
            self.calls.append(request)
            return {'allowed': False, 'reason': 'excluded'}
        provider = self.provider(deny)
        provider.initialize('s1', hermes_home=str(self.home), cwd='C:/work/demo', memory_excluded=True)
        provider.sync_turn('Restricted synthetic payload', 'Answer', messages=[])
        self.assertEqual(provider.prefetch('Question'), '')
        self.assertEqual(provider.get_tool_schemas(), [])
        self.assertFalse((self.home / 'state').exists())
        self.assertEqual([c['operation'] for c in self.calls], ['policy'])

    def test_every_declared_exclusion_reaches_shared_policy(self):
        for field, value in [('restricted', True), ('persistence', 'exclude')]:
            with self.subTest(field=field):
                self.calls.clear()
                def policy(request):
                    self.calls.append(request)
                    return {'allowed': request['input'].get(field) != value}
                provider = self.provider(policy)
                provider.initialize('excluded-' + field, hermes_home=str(self.home),
                                    cwd=str(self.home), **{field: value})
                self.assertFalse(provider._allowed)
                self.assertEqual(self.calls[0]['input'].get(field), value)
                self.assertFalse((self.home / 'state').exists())

    def test_profile_defaults_cannot_weaken_a_session_exclusion(self):
        for field, denied, default in [('memory_excluded', True, False),
                                       ('classification', 'TLP:RED', 'public'),
                                       ('data_classification', 'TLP:AMBER', 'public'),
                                       ('purpose', 'observer', 'interactive')]:
            with self.subTest(field=field):
                self.calls.clear()
                def policy(request):
                    self.calls.append(request)
                    return {'allowed': request['input'].get(field) != denied}
                provider = module.HarnessMemoryProvider(bridge=policy, config_loader=lambda home: {
                    'enabled': True, 'repo': str(self.home), 'node': 'node', field: default})
                provider.initialize('excluded-' + field, hermes_home=str(self.home),
                                    cwd=str(self.home), **{field: denied})
                self.assertFalse(provider._allowed)
                self.assertFalse((self.home / 'state').exists())
                self.assertTrue(all(call['operation'] == 'policy' for call in self.calls))

    def test_profile_exclusion_applies_when_session_policy_allows(self):
        def policy(request):
            self.calls.append(request)
            return {'allowed': request['input'].get('classification') != 'TLP:RED'}
        provider = module.HarnessMemoryProvider(bridge=policy, config_loader=lambda home: {
            'enabled': True, 'repo': str(self.home), 'node': 'node', 'classification': 'TLP:RED'})
        provider.initialize('excluded-profile', hermes_home=str(self.home),
                            cwd=str(self.home), classification='public')
        self.assertFalse(provider._allowed)
        self.assertFalse((self.home / 'state').exists())
        self.assertTrue(all(call['operation'] == 'policy' for call in self.calls))

    def test_excluded_delegation_does_not_call_bridge(self):
        provider = self.provider(lambda request: {'allowed': False})
        provider.initialize('excluded', hermes_home=str(self.home), cwd=str(self.home))
        provider.on_delegation('Synthetic task', 'Synthetic result', child_session_id='child')
        self.assertFalse((self.home / 'state').exists())

    def test_profiles_have_independent_binding_and_no_native_memory_mirroring(self):
        first = self.provider()
        second = self.provider()
        first.initialize('s1', hermes_home=str(self.home / 'one'), cwd='C:/one')
        second.initialize('s2', hermes_home=str(self.home / 'two'), cwd='C:/two')
        first.on_memory_write('add', 'user', 'native-private', {})
        first.sync_turn('One', 'A', session_id='s1')
        second.sync_turn('Two', 'B', session_id='s2')
        captured = [r for r in self.calls if r['operation'] == 'capture']
        self.assertEqual([r['snapshot']['cwd'] for r in captured], ['C:/one', 'C:/two'])
        self.assertNotIn('native-private', json.dumps(self.calls))

    def test_later_exclusion_taints_registration_without_retaining_content(self):
        provider = self.provider()
        provider.initialize('s1', hermes_home=str(self.home), cwd='C:/work')
        def deny(request): return {'allowed': False}
        excluded = self.provider(deny)
        excluded.initialize('s1', hermes_home=str(self.home), cwd='C:/work', memory_excluded=True)
        registry = json.loads((self.home / 'state' / 'harness-memory-sessions.json').read_text())
        self.assertTrue(registry['sessions']['s1']['memory_excluded'])
        self.assertEqual(excluded.prefetch('Question'), '')

    def test_pinned_snapshot_keeps_its_session_and_policy_when_native_runtime_switches(self):
        provider = self.provider()
        provider.initialize('first', hermes_home=str(self.home), cwd='C:/work')
        request = provider._capture_request([{'role': 'user', 'content': 'First task'}])
        provider.on_session_switch('second')
        provider._request(request)
        request = [r for r in self.calls if r['operation'] == 'capture'][-1]
        self.assertEqual(request['snapshot']['session_id'], 'first')
        self.assertEqual(request['input']['sessionId'], 'first')

    def test_new_session_lineage_keeps_native_source_and_delegation_distinct(self):
        database = sqlite3.connect(self.home / 'state.db')
        database.execute('CREATE TABLE sessions(id TEXT, parent_session_id TEXT, model TEXT, cwd TEXT, source TEXT)')
        database.executemany('INSERT INTO sessions VALUES(?, ?, ?, ?, ?)', [
            ('first', None, 'm1', str(self.home), 'cli'),
            ('second', 'first', 'm1', str(self.home), 'cli'),
            ('child', 'second', 'm1', str(self.home), 'subagent')])
        database.commit()
        database.close()
        provider = self.provider()
        provider.initialize('first', hermes_home=str(self.home), cwd=str(self.home))
        provider.on_session_switch('second', parent_session_id='first', reset=True)
        provider.sync_turn('New task', 'New answer', session_id='second')
        provider.on_delegation('Child assignment', 'Child answer', child_session_id='child')
        snapshots = [r['snapshot'] for r in self.calls if r['operation'] == 'capture']
        self.assertEqual(snapshots[0]['source'], 'cli')
        self.assertEqual(snapshots[0]['parent_session_id'], 'first')
        self.assertEqual(snapshots[0]['task'], '')
        self.assertEqual(snapshots[0]['messages'][0]['content'], 'New task')
        self.assertEqual(snapshots[1]['source'], 'subagent')
        self.assertEqual(snapshots[1]['task'], 'Child assignment')

    def test_scoped_tool_call_refuses_another_profile(self):
        provider = self.provider()
        provider.initialize('s1', hermes_home=str(self.home), cwd='C:/work')
        count = len(self.calls)
        result = json.loads(provider.handle_tool_call('search_context', {'query': 'x'}, hermes_home=str(self.home / 'another')))
        self.assertIn('profile mismatch', result['error'])
        self.assertEqual(len(self.calls), count)

    def test_session_switch_reevaluates_new_restriction_and_clears_recall(self):
        def policy(request):
            self.calls.append(request)
            if request['operation'] == 'policy':
                return {'allowed': request['input'].get('classification') != 'TLP:RED'}
            return self.bridge(request)
        provider = self.provider(policy)
        provider.initialize('public', hermes_home=str(self.home), cwd='C:/work')
        provider.on_session_switch('restricted', classification='TLP:RED')
        self.assertEqual(provider.prefetch('question'), '')
        self.assertEqual(provider.get_tool_schemas(), [])
        before = len(self.calls)
        provider.sync_turn('restricted payload', 'Answer')
        self.assertEqual(len(self.calls), before)
        registry = json.loads((self.home / 'state' / 'harness-memory-sessions.json').read_text())
        self.assertNotIn('restricted', registry['sessions'])

    def test_native_ancestry_is_forwarded_before_startup_recall(self):
        database = sqlite3.connect(self.home / 'state.db')
        database.execute('CREATE TABLE sessions(id TEXT, parent_session_id TEXT, model TEXT, cwd TEXT)')
        database.executemany('INSERT INTO sessions VALUES(?, ?, ?, ?)', [
            ('grandparent', None, 'm1', 'C:/work'), ('parent', 'grandparent', 'm1', 'C:/work'), ('child', 'parent', 'm1', 'C:/work')])
        database.commit()
        database.close()
        def deny_ancestor(request):
            self.calls.append(request)
            return {'allowed': 'grandparent' not in request['input']['ancestorSessions']}
        provider = self.provider(deny_ancestor)
        provider.initialize('child', hermes_home=str(self.home), cwd='C:/work')
        self.assertEqual(self.calls[0]['input']['ancestorSessions'], ['parent', 'grandparent'])
        self.assertEqual(provider.get_tool_schemas(), [])
        self.assertFalse((self.home / 'state').exists())


if __name__ == '__main__': unittest.main()
