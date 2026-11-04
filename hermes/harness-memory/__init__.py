"""Hermes adapter for the shared agentic-harness memory pipeline.

Uses the supported MemoryProvider ABC from NousResearch/hermes-agent (MIT),
inspected at b200f5bc60. No upstream implementation code is copied.
"""
from __future__ import annotations

import copy
import json
import logging
import math
import os
from pathlib import Path
import subprocess
import sqlite3
import tempfile
import time

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)
POLICY_FIELDS = ('memory_excluded', 'restricted', 'persistence', 'purpose', 'classification', 'data_classification')


def load_config(home):
    file = Path(home) / 'harness-memory.json'
    if not file.is_file():
        return {}
    value = json.loads(file.read_text(encoding='utf-8'))
    return value if isinstance(value, dict) else {}


def current_home():
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())


class HarnessMemoryProvider(MemoryProvider):
    """Profile-bound bridge. Embedding and retrieval policy live in the harness."""

    def __init__(self, *, bridge=None, config_loader=load_config):
        self._bridge_override = bridge
        self._config_loader = config_loader
        self._home = None
        self._config = {}
        self._session_id = ''
        self._cwd = ''
        self._allowed = False
        self._brief = ''
        self._tools = None
        self._policy = {}
        self._parent = ''
        self._ancestors = []
        self._model = ''
        self._provider = ''
        self._timestamps = []
        self._started_at = time.time()

    @property
    def name(self):
        return 'harness-memory'

    def is_available(self):
        config = self._config_loader(self._home or current_home())
        return config.get('enabled') is True and bool(config.get('repo')) and bool(config.get('node'))

    def unavailable_reason(self):
        return 'Install the harness adapter and configure this profile using harness-memory.json.'

    def _request(self, request):
        snapshot = request.get('snapshot') or {}
        request = {**request, 'input': request.get('input') or ({'sessionId': snapshot.get('session_id'),
                   'cwd': snapshot.get('cwd'), 'parentSession': snapshot.get('parent_session_id'),
                   'ancestorSessions': snapshot.get('ancestorSessions', []),
                   **{key: snapshot[key] for key in POLICY_FIELDS if key in snapshot}} if snapshot else {'sessionId': self._session_id,
                   'cwd': self._cwd, 'parentSession': self._parent, 'ancestorSessions': self._ancestors, **self._policy})}
        if self._bridge_override:
            return self._bridge_override(request)
        bridge = Path(self._config['repo']) / 'hermes' / 'bridge.mjs'
        options = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        result = subprocess.run([self._config['node'], str(bridge)], input=json.dumps(request),
                                text=True, encoding='utf-8', capture_output=True, timeout=30,
                                cwd=self._config['repo'], check=False, **options)
        if result.returncode:
            raise RuntimeError('shared memory bridge failed')
        return json.loads(result.stdout)

    def initialize(self, session_id, **kwargs):
        if not kwargs.get('hermes_home'):
            raise ValueError('profile-scoped hermes_home is required')
        bound_home = Path(kwargs['hermes_home']).resolve()
        if self._home is not None and self._home != bound_home:
            self._allowed = False
            raise ValueError('a memory provider cannot be rebound to another profile')
        self._allowed = False
        self._brief = ''
        self._tools = None
        self._timestamps = []
        self._started_at = time.time()
        self._home = bound_home
        self._config = self._config_loader(self._home)
        self._session_id = str(session_id or '')
        self._cwd = str(kwargs.get('cwd') or '')
        self._parent = str(kwargs.get('parent_session_id') or '')
        session_policy = {key: kwargs[key] for key in POLICY_FIELDS if key in kwargs}
        self._policy = dict(session_policy)
        self._policy.update({key: self._config[key] for key in POLICY_FIELDS if key in self._config})
        registry = self._home / 'state' / 'harness-memory-sessions.json'
        if registry.exists():
            previous = json.loads(registry.read_text(encoding='utf-8')).get('sessions', {}).get(self._session_id, {})
            if previous.get('memory_excluded'):
                self._policy['memory_excluded'] = True
        self._model = str(kwargs.get('model') or '')
        self._provider = str(kwargs.get('provider') or '')
        metadata = self._native_session_metadata(self._session_id)
        self._parent = str(metadata.get('parent_session_id') or self._parent)
        self._ancestors = metadata.get('ancestorSessions', [self._parent] if self._parent else [])
        self._allowed = False
        if not self._config.get('enabled') or not self._session_id:
            return
        # A profile default must never weaken a session restriction. Ask the
        # shared policy to approve both scopes rather than duplicating its
        # classification and exclusion rules in the native adapter.
        self._allowed = all(self._request({'operation': 'policy', 'input': {
            'sessionId': self._session_id, 'cwd': self._cwd, 'parentSession': self._parent,
            'ancestorSessions': self._ancestors, **scope}}).get('allowed') is True
            for scope in (session_policy, self._policy))
        if not self._allowed:
            self._policy['memory_excluded'] = True
            if registry.exists() and self._session_id in json.loads(registry.read_text(encoding='utf-8')).get('sessions', {}):
                self._register_session()
            logger.warning('Harness memory excluded this session; native history controls remain separate.')
            return
        self._register_session()
        response = self._request({'operation': 'brief', 'session_id': self._session_id,
                                  'cwd': self._cwd, 'parent_session_id': self._parent,
                                  'ancestorSessions': self._ancestors, **self._policy})
        self._brief = str(response.get('context') or '')

    def _register_session(self):
        directory = self._home / 'state'
        directory.mkdir(parents=True, exist_ok=True)
        lock = directory / 'harness-memory-sessions.lock'
        deadline = time.monotonic() + 2
        while True:
            try:
                fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                break
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('memory registration index is busy')
                time.sleep(0.02)
        try:
            file = directory / 'harness-memory-sessions.json'
            state = json.loads(file.read_text(encoding='utf-8')) if file.exists() else {'sessions': {}}
            sessions = state.setdefault('sessions', {})
            registered_at = sessions.get(self._session_id, {}).get('registered_at')
            try:
                valid_timestamp = (type(registered_at) in (int, float)
                                   and registered_at > 0 and math.isfinite(registered_at))
            except OverflowError:
                valid_timestamp = False
            if not valid_timestamp:
                # Legacy entries begin their descendant discovery window now;
                # a resumed old parent must not opt historical children in.
                registered_at = time.time()
            sessions[self._session_id] = {'cwd': self._cwd, 'registered_at': registered_at, **self._policy}
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=directory, delete=False) as output:
                json.dump(state, output)
                temporary = output.name
            os.replace(temporary, file)
        finally:
            lock.unlink()

    def system_prompt_block(self):
        return ''

    def prefetch(self, query, *, session_id=''):
        if not self._allowed or (session_id and session_id != self._session_id):
            return ''
        brief, self._brief = self._brief, ''
        return brief

    def get_tool_schemas(self):
        if not self._allowed:
            return []
        if self._tools is None:
            response = self._request({'operation': 'tools'})
            self._tools = [{'name': tool['name'], 'description': tool.get('description', ''),
                            'parameters': tool['inputSchema']} for tool in response.get('tools', [])
                           if tool.get('name') in ('search_context', 'get_document')]
        return copy.deepcopy(self._tools)

    def handle_tool_call(self, tool_name, args, **kwargs):
        if kwargs.get('hermes_home') and Path(kwargs['hermes_home']).resolve() != self._home:
            return json.dumps({'error': 'shared memory profile mismatch'})
        if not self._allowed or tool_name not in ('search_context', 'get_document'):
            return json.dumps({'error': 'shared memory tool unavailable'})
        return json.dumps(self._request({'operation': 'call', 'name': tool_name, 'arguments': args}))

    def on_turn_start(self, turn_number, message, **kwargs):
        self._model = str(kwargs.get('model') or self._model)

    def _native_session_metadata(self, session_id):
        """Native initialization does not supply model/provider; read only this row's metadata."""
        database = self._home / 'state.db'
        if not database.is_file():
            return {}
        connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=1)
        try:
            connection.row_factory = sqlite3.Row
            columns = {row[1] for row in connection.execute('PRAGMA table_info(sessions)')}
            selected = [key for key in ('model', 'billing_provider', 'started_at', 'cwd', 'parent_session_id', 'source') if key in columns]
            if not selected:
                return {}
            row = connection.execute('SELECT ' + ', '.join(selected) + ' FROM sessions WHERE id = ?', (session_id,)).fetchone()
            if row is None:
                return {}
            metadata = dict(row)
            ancestors, seen = [], {session_id}
            next_id = metadata.get('parent_session_id')
            while next_id:
                if next_id in seen or len(ancestors) >= 128:
                    raise ValueError('native memory session ancestry is invalid')
                seen.add(next_id)
                ancestors.append(next_id)
                ancestor = connection.execute('SELECT parent_session_id FROM sessions WHERE id = ?', (next_id,)).fetchone()
                if ancestor is None:
                    raise ValueError('native memory session ancestry cannot be verified')
                next_id = ancestor['parent_session_id']
            metadata['ancestorSessions'] = ancestors
            return metadata
        finally:
            connection.close()

    def _capture_request(self, messages, *, concluded=False, task='', child_session_id=''):
        if not self._allowed:
            return None
        metadata = self._native_session_metadata(child_session_id or self._session_id)
        messages = copy.deepcopy(messages)
        now = time.time()
        if not child_session_id:
            self._timestamps.extend([now] * max(0, len(messages) - len(self._timestamps)))
        for index, message in enumerate(messages):
            if isinstance(message, dict) and not message.get('timestamp'):
                message['timestamp'] = now if child_session_id else self._timestamps[index]
        snapshot = {'session_id': child_session_id or self._session_id, 'cwd': metadata.get('cwd') or self._cwd,
                    'source': metadata.get('source') or ('subagent' if child_session_id else 'hermes'),
                    'parent_session_id': self._session_id if child_session_id else self._parent,
                    'ancestorSessions': metadata.get('ancestorSessions', [self._session_id, *self._ancestors] if child_session_id else self._ancestors),
                    'model': metadata.get('model') or self._model, 'provider': metadata.get('billing_provider') or self._provider,
                    'messages': messages, 'started_at': metadata.get('started_at') or self._started_at,
                    'concluded': concluded, 'task': task, **self._policy}
        return {'operation': 'capture', 'snapshot': snapshot, 'input': {'sessionId': snapshot['session_id'],
                'cwd': snapshot['cwd'], 'parentSession': snapshot['parent_session_id'],
                'ancestorSessions': snapshot['ancestorSessions'], **{key: snapshot[key] for key in POLICY_FIELDS if key in snapshot}}}

    def sync_turn(self, user_content, assistant_content, *, session_id='', messages=None, turn_author=None):
        if not self._allowed:
            return
        if session_id and session_id != self._session_id:
            raise ValueError('session switch must bind memory before capture')
        snapshot = messages if messages is not None else [
            {'role': 'user', 'content': user_content}, {'role': 'assistant', 'content': assistant_content}]
        # Hermes MemoryManager already invokes sync_turn on its serialized
        # background writer. A second thread would defeat native end/switch ordering.
        self._request(self._capture_request(snapshot))

    def on_session_end(self, messages):
        if self._allowed:
            self._request(self._capture_request(messages, concluded=True))

    def on_session_switch(self, new_session_id, *, parent_session_id='', **kwargs):
        context = {'hermes_home': str(self._home), 'cwd': self._cwd, 'model': self._model,
                   'provider': self._provider, **self._policy, **kwargs, 'parent_session_id': parent_session_id}
        self.initialize(new_session_id, **context)

    def on_delegation(self, task, result, *, child_session_id='', **kwargs):
        if not self._allowed:
            return
        if not child_session_id:
            logger.warning('Harness child capture requires a stable native child session id.')
            return
        self._request(self._capture_request([{'role': 'assistant', 'content': result}], concluded=True,
                                           task=task, child_session_id=child_session_id))

    def on_memory_write(self, action, target, content, metadata=None):
        # Native profile memory is deliberately not mirrored as a second producer.
        return None

    def shutdown(self):
        return None


def register(ctx):
    ctx.register_memory_provider(HarnessMemoryProvider())
