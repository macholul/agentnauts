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

describe('toRoomMessage', () => {
  it('strips details unless sharing is enabled', async () => {
    const { toRoomMessage } = await import('./room');
    const { events } = normalizeHookPayload({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'cat ~/.secrets' },
    });
    const event = events[0]!;
    const privateMsg = toRoomMessage(event, { name: 'bob', shareDetails: false });
    assert.equal(privateMsg.owner, 'bob');
    assert.equal(privateMsg.event.toolName, 'Bash');
    assert.equal(privateMsg.event.detail, undefined);
    const shared = toRoomMessage(event, { name: 'bob', shareDetails: true });
    assert.equal(shared.event.detail, 'cat ~/.secrets');
  });

  it('validates room settings from env and from the web app', async () => {
    const { roomSettingsFromEnv, parseRoomSettings } = await import('./room');
    assert.equal(roomSettingsFromEnv({}).settings, null);
    assert.ok(roomSettingsFromEnv({ GROUNDCREW_ROOM: 'abcdef123' }).problem, 'name is required');
    assert.ok(roomSettingsFromEnv({ GROUNDCREW_ROOM: 'ab', GROUNDCREW_NAME: 'bob' }).problem, 'code too short');
    const ok = roomSettingsFromEnv({ GROUNDCREW_ROOM: 'team-rocket-42', GROUNDCREW_NAME: ' bob ' });
    assert.equal(ok.settings?.name, 'bob');
    assert.equal(ok.settings?.shareDetails, false);
    assert.equal(parseRoomSettings({ room: 'x', name: 'a' }), null);
    assert.equal(parseRoomSettings({ room: 'crew-abcd-efgh', name: '' }), null);
    assert.deepEqual(parseRoomSettings({ room: 'crew-abcd-efgh', name: 'amy', shareDetails: true }), {
      room: 'crew-abcd-efgh',
      name: 'amy',
      shareDetails: true,
    });
  });

  it('remembers the chosen room across restarts, unless pinned by env', async () => {
    const { RoomManager } = await import('./room');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'gc-')), 'room.json');
    const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' };
    const quiet = () => {};
    const first = new RoomManager({ env, log: quiet, file });
    assert.equal(first.current, null);
    assert.ok(first.set({ room: 'crew-abcd-efgh', name: 'amy', shareDetails: false }));
    const second = new RoomManager({ env, log: quiet, file });
    assert.equal(second.current?.room, 'crew-abcd-efgh');
    second.set(null);
    assert.equal(new RoomManager({ env, log: quiet, file }).current, null);

    const pinned = new RoomManager({ env: { ...env, GROUNDCREW_ROOM: 'team-rocket-42', GROUNDCREW_NAME: 'bob' }, log: quiet, file });
    assert.equal(pinned.set(null), false);
    assert.equal(pinned.current?.room, 'team-rocket-42');

    const noCloud = new RoomManager({ env: {}, log: quiet, file });
    assert.equal(noCloud.current, null, 'no Supabase project configured means no sharing');
  });
});
