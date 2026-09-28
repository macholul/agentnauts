import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { webcrypto } from 'node:crypto';
import { generateRoomCode, isValidRoomCode, keyFingerprint, verifyRoomEnvelope, type AgentEvent } from '@groundcrew/shared';
import { loadOrCreateIdentity } from './identity';
import { ProjectAliases, RoomManager, parseRoomSettings, roomSettingsFromEnv, signRoomContent, toRoomContent } from './room';

const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'gc-')), name);
const code = () => generateRoomCode((n) => webcrypto.getRandomValues(new Uint32Array(n)));
const quiet = () => {};

const event: AgentEvent = {
  id: 'e1',
  sessionId: 's1',
  type: 'tool_start',
  toolName: 'Bash',
  detail: 'cat ~/.secrets',
  sessionName: 'acme-payments',
  timestamp: 1,
};

describe('room codes', () => {
  it('accepts only generated codes', () => {
    for (let i = 0; i < 50; i++) assert.ok(isValidRoomCode(code()));
    for (const bad of ['team-1', 'crew-abcd-efgh', 'crew-ABCD-efgh-jkmn', 'crew-abcd-efgh-jkm0', 'my-cool-room-123']) {
      assert.ok(!isValidRoomCode(bad), bad);
    }
  });
});

describe('what gets shared', () => {
  const settings = { room: 'crew-abcd-efgh-jkmn', name: 'bob', shareDetails: false };

  it('hides details and project names by default, with stable aliases', () => {
    const aliases = new ProjectAliases();
    const first = toRoomContent(event, settings, 'KEY', aliases);
    assert.equal(first.event.detail, undefined);
    assert.equal(first.event.sessionName, 'project 1');
    assert.equal(first.event.toolName, 'Bash');
    assert.equal(toRoomContent({ ...event, sessionName: 'other' }, settings, 'KEY', aliases).event.sessionName, 'project 2');
    assert.equal(toRoomContent(event, settings, 'KEY', aliases).event.sessionName, 'project 1');
  });

  it('shares details only when asked to', () => {
    const shared = toRoomContent(event, { ...settings, shareDetails: true }, 'KEY', new ProjectAliases());
    assert.equal(shared.event.detail, 'cat ~/.secrets');
    assert.equal(shared.event.sessionName, 'acme-payments');
  });
});

describe('signatures', () => {
  it('verifies genuine messages and rejects forged, tampered or replayed ones', async () => {
    const alice = loadOrCreateIdentity(tempFile('alice.json'));
    const mallory = loadOrCreateIdentity(tempFile('mallory.json'));
    const room = 'crew-abcd-efgh-jkmn';
    const content = toRoomContent(event, { room, name: 'alice', shareDetails: false }, alice.publicKey, new ProjectAliases());
    const envelope = signRoomContent(content, alice);

    const verified = await verifyRoomEnvelope(envelope, room);
    assert.equal(verified?.owner, 'alice');
    assert.equal(verified?.key, alice.publicKey);

    // Mallory claims to be alice using alice's public key, signing with her own.
    const forged = signRoomContent({ ...content }, mallory);
    assert.equal(await verifyRoomEnvelope(forged, room), null);

    // Tampering with the signed data breaks the signature.
    const tampered = { ...envelope, data: envelope.data.replace('"alice"', '"eve"') };
    assert.equal(await verifyRoomEnvelope(tampered, room), null);

    // A genuine message can't be replayed into another room.
    assert.equal(await verifyRoomEnvelope(envelope, 'crew-zzzz-zzzz-zzzz'), null);
  });

  it('keeps the same identity across restarts, in a private file', () => {
    const file = tempFile('identity.json');
    const a = loadOrCreateIdentity(file);
    const b = loadOrCreateIdentity(file);
    assert.equal(a.publicKey, b.publicKey);
    assert.match(keyFingerprint(a.publicKey), /^[0-9a-f]{4}-[0-9a-f]{4}$/);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

describe('room settings', () => {
  it('validates settings from env and from the web app', () => {
    const room = code();
    assert.equal(roomSettingsFromEnv({}).settings, null);
    assert.ok(roomSettingsFromEnv({ GROUNDCREW_ROOM: room }).problem, 'name is required');
    assert.ok(roomSettingsFromEnv({ GROUNDCREW_ROOM: 'team-rocket-42', GROUNDCREW_NAME: 'bob' }).problem, 'hand-made code');
    assert.equal(roomSettingsFromEnv({ GROUNDCREW_ROOM: room, GROUNDCREW_NAME: ' bob ' }).settings?.name, 'bob');
    assert.equal(parseRoomSettings({ room, name: '' }), null);
    assert.deepEqual(parseRoomSettings({ room, name: 'amy', shareDetails: true }), { room, name: 'amy', shareDetails: true });
  });

  it('never resumes a remembered room without being asked', () => {
    const file = tempFile('room.json');
    const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' };
    const identity = loadOrCreateIdentity(tempFile('id.json'));
    const room = code();

    const first = new RoomManager({ env, identity, log: quiet, file });
    assert.ok(first.set({ room, name: 'amy', shareDetails: false }));
    assert.equal(first.current?.room, room);

    // After a restart the room is remembered, but not shared.
    // (A function, so TypeScript doesn't narrow `current` across set() calls.)
    const activeRoom = (m: RoomManager) => m.current?.room;
    const second = new RoomManager({ env, identity, log: quiet, file });
    assert.equal(activeRoom(second), undefined);
    assert.equal(second.resumable?.room, room);

    // Resuming is an explicit set(); forgetting clears it for good.
    second.set(second.resumable);
    assert.equal(activeRoom(second), room);
    second.set(null);
    assert.equal(new RoomManager({ env, identity, log: quiet, file }).resumable, null);

    // Env vars pin the room deliberately, so that one is active right away.
    const pinned = new RoomManager({ env: { ...env, GROUNDCREW_ROOM: room, GROUNDCREW_NAME: 'bob' }, identity, log: quiet, file });
    assert.equal(pinned.current?.room, room);
    assert.equal(pinned.set(null), false);

    assert.equal(new RoomManager({ env: {}, identity, log: quiet, file }).current, null, 'no Supabase project, no sharing');
  });
});
