/**
 * The hooks installer works on the person's own Claude Code settings, so
 * these tests are mostly about what it must not touch.
 */
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  HOOK_EVENTS,
  HooksError,
  hookCommand,
  hooksState,
  installHooks,
  installedHooks,
  settingsFile,
  uninstallHooks,
  withHooks,
  withoutHooks,
  type JsonObject,
} from './hooks';

const LEGACY = "curl -s -X POST -H 'Content-Type: application/json' -d @- http://localhost:4747/event || true";
const THEIRS = { type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' };

/** Someone's settings: other options, and hooks of their own in events we use and one we don't. */
const settings = (): JsonObject => ({
  model: 'opus',
  permissions: { allow: ['Bash(npm test:*)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check-command.sh' }] }],
    Stop: [{ hooks: [THEIRS] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'echo compacting' }] }],
  },
});

function fileWith(text: string | null): string {
  const file = join(mkdtempSync(join(tmpdir(), 'an-hooks-')), '.claude', 'settings.json');
  if (text !== null) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return file;
}

const commandsIn = (value: JsonObject, event: string): string[] =>
  ((value.hooks as Record<string, { hooks: { command: string }[] }[]>)[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));

describe('hooks in settings', () => {
  it('adds one hook to every event and keeps everything else', () => {
    const before = settings();
    const after = withHooks(before, 4747);
    for (const [event] of HOOK_EVENTS) {
      assert.equal(commandsIn(after, event).filter((c) => c === hookCommand(4747)).length, 1, event);
    }
    assert.equal(after.model, 'opus');
    assert.deepEqual(after.permissions, before.permissions);
    assert.deepEqual(commandsIn(after, 'PreToolUse'), ['./check-command.sh', hookCommand(4747)]);
    assert.deepEqual(commandsIn(after, 'Stop'), [THEIRS.command, hookCommand(4747)]);
    assert.deepEqual(commandsIn(after, 'PreCompact'), ['echo compacting']);
    // Tool events watch every tool, and Claude Code may give up on the hook after a few seconds.
    const added = (event: string) => (after.hooks as Record<string, unknown[]>)[event]!.at(-1);
    assert.deepEqual(added('PreToolUse'), { matcher: '*', hooks: [{ type: 'command', command: hookCommand(4747), timeout: 5 }] });
    assert.deepEqual(added('SessionEnd'), { hooks: [{ type: 'command', command: hookCommand(4747), timeout: 5 }] });
    // The settings handed in are not modified.
    assert.deepEqual(before, settings());
  });

  it('changes nothing the second time', () => {
    const once = withHooks(settings(), 4747);
    assert.equal(withHooks(once, 4747), once);
    assert.equal(hooksState(once, 4747), 'installed');
    assert.equal(hooksState(settings(), 4747), 'missing');
  });

  it('is removed without a trace', () => {
    assert.deepEqual(withoutHooks(withHooks(settings(), 4747)), settings());
    assert.deepEqual(withoutHooks(withHooks({ model: 'opus' }, 4747)), { model: 'opus' });
    assert.deepEqual(withoutHooks(withHooks({}, 4747)), {});
    // Nothing of ours: the very same object comes back.
    const theirs = settings();
    assert.equal(withoutHooks(theirs), theirs);
  });

  it('moves to another port, and replaces hooks pasted by hand from the old README', () => {
    const moved = withHooks(withHooks(settings(), 4747), 5005);
    assert.equal(hooksState(withHooks(settings(), 4747), 5005), 'outdated');
    assert.deepEqual(commandsIn(moved, 'Stop'), [THEIRS.command, hookCommand(5005)]);

    const pasted: JsonObject = {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: LEGACY }] }],
        Stop: [{ hooks: [THEIRS, { type: 'command', command: LEGACY }] }],
      },
    };
    assert.equal(hooksState(pasted, 4747), 'outdated');
    const upgraded = withHooks(pasted, 4747);
    assert.deepEqual(commandsIn(upgraded, 'PreToolUse'), [hookCommand(4747)]);
    assert.deepEqual(commandsIn(upgraded, 'Stop'), [THEIRS.command, hookCommand(4747)]);
    assert.deepEqual(withoutHooks(pasted), { hooks: { Stop: [{ hooks: [THEIRS] }] } });
  });

  it("leaves other tools' hooks alone, even ones that look similar", () => {
    const other = "curl -s -X POST -d @- http://localhost:9000/event || true";
    const theirs: JsonObject = { hooks: { Stop: [{ hooks: [{ type: 'command', command: other }] }] } };
    assert.equal(withoutHooks(theirs), theirs);
    assert.deepEqual(commandsIn(withHooks(theirs, 4747), 'Stop'), [other, hookCommand(4747)]);
  });

  it('refuses settings it does not understand', () => {
    assert.throws(() => withHooks({ hooks: 'none' }, 4747), HooksError);
    assert.throws(() => withHooks({ hooks: { Stop: {} } }, 4747), HooksError);
    assert.throws(() => withoutHooks({ hooks: [] }), HooksError);
  });
});

describe('the settings file', () => {
  it('is created when there is none', () => {
    const file = fileWith(null);
    assert.equal(installedHooks(file, 4747), 'missing');
    assert.equal(installHooks(file, 4747), 'added');
    assert.equal(installedHooks(file, 4747), 'installed');
    assert.equal(installHooks(file, 4747), 'unchanged');
    assert.equal(installHooks(file, 5005), 'updated');
    assert.equal(uninstallHooks(file), 'removed');
    assert.equal(uninstallHooks(file), 'none');
    assert.equal(readFileSync(file, 'utf8'), '{}\n');
  });

  it('comes back byte for byte after install and uninstall', () => {
    for (const text of [
      JSON.stringify(settings(), null, 2) + '\n',
      JSON.stringify(settings(), null, 4),
      JSON.stringify(settings(), null, '\t') + '\n',
      (JSON.stringify(settings(), null, 2) + '\n').replace(/\n/g, '\r\n'),
    ]) {
      const file = fileWith(text);
      assert.equal(installHooks(file, 4747), 'added');
      assert.notEqual(readFileSync(file, 'utf8'), text);
      assert.equal(uninstallHooks(file), 'removed');
      assert.equal(readFileSync(file, 'utf8'), text);
      // No temporary files left next to it.
      assert.deepEqual(readdirSync(dirname(file)), ['settings.json']);
    }
  });

  it('is left alone when it is not valid JSON', () => {
    const broken = '{ "model": "opus", // my favourite\n}';
    const file = fileWith(broken);
    assert.throws(() => installHooks(file, 4747), /not valid JSON/);
    assert.throws(() => uninstallHooks(file), HooksError);
    assert.throws(() => installedHooks(file, 4747), HooksError);
    assert.equal(readFileSync(file, 'utf8'), broken);
    assert.throws(() => installHooks(fileWith('[]'), 4747), HooksError);
  });

  it('writes through a link instead of replacing it', { skip: process.platform === 'win32' }, () => {
    const real = fileWith('{}\n');
    const link = join(mkdtempSync(join(tmpdir(), 'an-link-')), 'settings.json');
    symlinkSync(real, link);
    installHooks(link, 4747);
    assert.equal(installedHooks(real, 4747), 'installed');
    assert.equal(installedHooks(link, 4747), 'installed');
    assert.ok(lstatSync(link).isSymbolicLink());
  });

  it("is found in Claude Code's own folder", () => {
    assert.equal(settingsFile({ CLAUDE_CONFIG_DIR: join('/', 'elsewhere') }), join('/', 'elsewhere', 'settings.json'));
    assert.match(settingsFile({}), /[\\/]\.claude[\\/]settings\.json$/);
  });
});

describe('the hook command', () => {
  it('can never fail or hang a Claude Code session', () => {
    const command = hookCommand(4747);
    assert.match(command, /\|\| true/);
    assert.match(command, / -m 2 /);
    assert.match(command, /http:\/\/127\.0\.0\.1:4747\/event/);
  });

  it('is what the example for adding the hooks by hand shows', () => {
    const example = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'claude-settings.example.json'), 'utf8')) as JsonObject;
    assert.deepEqual(example, withHooks({}, 4747));
  });
});
