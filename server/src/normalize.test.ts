import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeHookPayload, toolDetail } from './normalize';
import { isAllowedOrigin } from './origin';

const base = {
  session_id: 'abc123',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/home/me/projects/groundcrew',
  permission_mode: 'default',
};

describe('normalizeHookPayload', () => {
  it('maps PreToolUse to tool_start with a short detail', () => {
    const { events, warning } = normalizeHookPayload({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/home/me/projects/groundcrew/web/src/App.tsx', old_string: 'a', new_string: 'b' },
      tool_use_id: 'toolu_1',
    });
    assert.equal(warning, undefined);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event?.type, 'tool_start');
    assert.equal(event?.toolName, 'Edit');
    assert.equal(event?.detail, 'App.tsx');
    assert.equal(event?.sessionId, 'abc123');
    assert.equal(event?.sessionName, 'groundcrew');
    assert.equal(event?.subagent, undefined);
  });

  it('maps PostToolUse to tool_end and keeps only the first line of commands', () => {
    const { events } = normalizeHookPayload({
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test\necho done' },
      tool_response: { stdout: 'lots of output' },
    });
    assert.equal(events[0]?.type, 'tool_end');
    assert.equal(events[0]?.detail, 'npm test');
  });

  it('attributes tool calls inside a subagent to that subagent', () => {
    const { events } = normalizeHookPayload({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'TODO' },
      agent_id: 'agent-7',
      agent_type: 'Explore',
    });
    assert.deepEqual(events[0]?.subagent, { id: 'agent-7', name: 'Explore' });
  });

  it('turns waiting notifications into notification events and ignores the rest', () => {
    const waiting = normalizeHookPayload({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    assert.equal(waiting.events[0]?.type, 'notification');
    assert.equal(waiting.events[0]?.detail, 'Needs your permission');

    const legacy = normalizeHookPayload({
      ...base,
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    assert.equal(legacy.events[0]?.type, 'notification');

    const info = normalizeHookPayload({ ...base, hook_event_name: 'Notification', notification_type: 'auth_success' });
    assert.equal(info.events.length, 0);
    assert.ok(info.warning);
  });

  it('maps session and subagent lifecycle hooks', () => {
    const types = ['SessionStart', 'Stop', 'SessionEnd', 'UserPromptSubmit'].map(
      (hook) => normalizeHookPayload({ ...base, hook_event_name: hook }).events[0]?.type,
    );
    assert.deepEqual(types, ['session_start', 'stop', 'session_end', 'user_prompt']);

    const start = normalizeHookPayload({ ...base, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Plan' });
    assert.equal(start.events[0]?.type, 'subagent_start');
    const stop = normalizeHookPayload({ ...base, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Plan' });
    assert.equal(stop.events[0]?.type, 'subagent_stop');
    assert.deepEqual(stop.events[0]?.subagent, { id: 'a1', name: 'Plan' });

    const insideSubagent = normalizeHookPayload({ ...base, hook_event_name: 'Stop', agent_id: 'a1' });
    assert.equal(insideSubagent.events[0]?.type, 'subagent_stop');
  });

  it('reports unknown and malformed payloads instead of throwing', () => {
    for (const payload of [null, 42, 'hi', [], {}, { hook_event_name: 'PreToolUse' }, { ...base, hook_event_name: 'Mystery' }]) {
      const result = normalizeHookPayload(payload);
      assert.equal(result.events.length, 0);
      assert.ok(result.warning, `expected a warning for ${JSON.stringify(payload)}`);
    }
    const noTool = normalizeHookPayload({ ...base, hook_event_name: 'PreToolUse', tool_input: 5 });
    assert.equal(noTool.events.length, 0);
  });
});

describe('toolDetail', () => {
  it('summarizes common tools', () => {
    assert.equal(toolDetail('WebFetch', { url: 'https://example.com/a/b?c=d' }), 'example.com');
    assert.equal(toolDetail('WebSearch', { query: 'three.js' }), 'three.js');
    assert.equal(toolDetail('Glob', { pattern: 'src/**/*.ts' }), 'src/**/*.ts');
    assert.equal(toolDetail('Task', { description: 'Find the bug', subagent_type: 'Explore' }), 'Find the bug');
    assert.equal(toolDetail('mcp__thing__do', { foo: 1 }), undefined);
    assert.equal(toolDetail('Read', 'not an object'), undefined);
    assert.ok((toolDetail('Bash', { command: 'x'.repeat(500) }) ?? '').length <= 48);
  });
});

describe('isAllowedOrigin', () => {
  it('allows localhost pages and configured origins only', () => {
    assert.ok(isAllowedOrigin('http://localhost:5173'));
    assert.ok(isAllowedOrigin('http://127.0.0.1:4173'));
    assert.ok(!isAllowedOrigin('https://evil.example'));
    assert.ok(!isAllowedOrigin('null'));
    assert.ok(isAllowedOrigin('http://192.168.1.5:5173', ['http://192.168.1.5:5173']));
  });
});

