import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentEvent } from './events';
import { mapEventToIntent } from './mapEventToIntent';

const event = (partial: Partial<AgentEvent>): AgentEvent => ({
  id: 'e1',
  sessionId: 's1',
  type: 'tool_start',
  timestamp: 0,
  ...partial,
});

describe('mapEventToIntent', () => {
  it('sends tools to their stations', () => {
    const cases: [string, string][] = [
      ['Edit', 'fabricator'],
      ['Write', 'fabricator'],
      ['MultiEdit', 'fabricator'],
      ['NotebookEdit', 'fabricator'],
      ['Read', 'scanner'],
      ['Grep', 'scanner'],
      ['Glob', 'scanner'],
      ['LS', 'scanner'],
      ['Bash', 'drill'],
      ['BashOutput', 'drill'],
      ['WebSearch', 'radar'],
      ['WebFetch', 'radar'],
      // MCP tools talk to outside services, like the radar.
      ['mcp__github__get_issue', 'radar'],
      ['mcp__d1aadfa9-e452-4fc9-a304-99dddf360809__execute_sql', 'radar'],
      ['mcp__tool', 'radar'],
    ];
    for (const [toolName, station] of cases) {
      const intent = mapEventToIntent(event({ toolName }));
      assert.equal(intent.kind, 'work', toolName);
      assert.equal(intent.kind === 'work' && intent.station, station, toolName);
    }
  });

  it('idles on tools without a station and Stop, waits on notifications, leaves on end', () => {
    assert.equal(mapEventToIntent(event({ toolName: 'TodoWrite' })).kind, 'idle');
    assert.equal(mapEventToIntent(event({ type: 'stop' })).kind, 'idle');
    assert.equal(mapEventToIntent(event({ type: 'notification' })).kind, 'wait');
    assert.equal(mapEventToIntent(event({ type: 'session_end' })).kind, 'leave');
    assert.equal(mapEventToIntent(event({ type: 'subagent_stop', subagent: { id: 'a' } })).kind, 'leave');
  });

  it('describes the activity', () => {
    const intent = mapEventToIntent(event({ toolName: 'Bash', detail: 'npm test' }));
    assert.equal(intent.activity, 'Running npm test');
  });

  it('gives MCP tools a readable name', () => {
    const activity = (toolName: string, detail?: string) => mapEventToIntent(event({ toolName, ...(detail ? { detail } : {}) })).activity;
    assert.equal(activity('mcp__Claude_Browser__preview_logs'), 'Claude Browser: preview logs');
    assert.equal(activity('mcp__github__get_issue', 'README.md'), 'github: get issue README.md');
    // A connector registered under an id: the id is noise, the tool is what matters.
    assert.equal(activity('mcp__d1aadfa9-e452-4fc9-a304-99dddf360809__execute_sql'), 'Using execute sql');
    assert.equal(activity('mcp__tool'), 'Using an outside tool');
  });
});
