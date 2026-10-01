import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  keyFingerprint,
  parseBridgeRoomRequest,
  verifyRoomEnvelope,
  type AgentEvent,
  type BridgeRoom,
} from '@agentnauts/shared';
import { loadOrCreateIdentity } from './identity';
import { ProjectAliases, RoomManager, signRoomContent, toRoomContent, tokenSecondsLeft } from './room';

const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'gc-')), name);
const code = () => generateRoomCode((n) => webcrypto.getRandomValues(new Uint32Array(n)));
const quiet = () => {};
const ROOM_ID = '5f0c2d4e-8b1a-4c3d-9e2f-1a2b3c4d5e6f';
const makeRoom = (overrides: Partial<BridgeRoom> = {}): BridgeRoom => ({
  roomId: ROOM_ID,
  code: 'crew-abcd-efgh-jkmn',
  roomName: 'Base',
  name: 'bob',
  shareDetails: false,
  ...overrides,
});
/** A JWT-shaped token that expires in `seconds` (only `exp` is read). */
const token = (seconds: number) =>
  ['h', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url'), 's'].join('.');

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

  it('takes a code out of a pasted invite link', () => {
    for (const pasted of [' CREW-9nu3-98ph-772x ', 'http://localhost:5173/?room=crew-9nu3-98ph-772x', 'localhost:5174/?room=crew-9nu3-98ph-772x&x=1']) {
      assert.equal(normalizeRoomCode(pasted), 'crew-9nu3-98ph-772x', pasted);
    }
  });
});

describe('what gets shared', () => {
  const settings = makeRoom();

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
    const shared = toRoomContent(event, makeRoom({ shareDetails: true }), 'KEY', new ProjectAliases());
    assert.equal(shared.event.detail, 'cat ~/.secrets');
    assert.equal(shared.event.sessionName, 'acme-payments');
  });
});

describe('signatures', () => {
  it('verifies genuine messages and rejects forged, tampered or replayed ones', async () => {
    const alice = loadOrCreateIdentity(tempFile('alice.json'));
    const mallory = loadOrCreateIdentity(tempFile('mallory.json'));
    const room = ROOM_ID;
    const content = toRoomContent(event, makeRoom({ name: 'alice' }), alice.publicKey, new ProjectAliases());
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
    assert.equal(await verifyRoomEnvelope(envelope, '00000000-0000-4000-8000-000000000000'), null);
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
  it('validates what the web app sends', () => {
    const good = { ...makeRoom(), accessToken: token(3600) };
    assert.ok(parseBridgeRoomRequest(good));
    assert.equal(parseBridgeRoomRequest({ ...good, accessToken: undefined }), null, 'token required');
    assert.equal(parseBridgeRoomRequest({ ...good, roomId: 'not-a-uuid' }), null);
    assert.equal(parseBridgeRoomRequest({ ...good, code: 'my-room' }), null);
    assert.equal(parseBridgeRoomRequest({ ...good, name: '  ' }), null);
    assert.equal(tokenSecondsLeft('garbage'), -1);
    assert.ok(tokenSecondsLeft(token(60)) > 50);
  });

  it('never resumes a remembered room without being asked, and never stores the token', () => {
    const file = tempFile('room.json');
    const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' };
    const identity = loadOrCreateIdentity(tempFile('id.json'));
    const room = makeRoom();
    // (A function, so TypeScript doesn't narrow getters across set() calls.)
    const activeRoom = (m: RoomManager) => m.current?.roomId;

    const first = new RoomManager({ env, identity, log: quiet, file });
    const secret = token(3600);
    first.set(room, secret);
    assert.equal(activeRoom(first), ROOM_ID);
    assert.equal(first.needsToken, false);
    assert.ok(!readFileSync(file, 'utf8').includes(secret), 'token must not be written to disk');

    // After a restart the room is remembered, but not shared, and has no token.
    const second = new RoomManager({ env, identity, log: quiet, file });
    assert.equal(activeRoom(second), undefined);
    assert.equal(second.resumable?.roomId, ROOM_ID);

    // Resuming is an explicit set() with a fresh token; forgetting clears it for good.
    second.set(second.resumable, token(3600));
    assert.equal(activeRoom(second), ROOM_ID);
    second.set(null);
    assert.equal(new RoomManager({ env, identity, log: quiet, file }).resumable, null);

    assert.equal(new RoomManager({ env: {}, identity, log: quiet, file }).current, null, 'no Supabase project, no sharing');
  });

  it('stops sharing when the token expires and picks up a refreshed one', () => {
    const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' };
    const identity = loadOrCreateIdentity(tempFile('id.json'));
    const manager = new RoomManager({ env, identity, log: quiet, file: tempFile('room.json') });
    let changes = 0;
    manager.onChange(() => changes++);
    manager.set(makeRoom(), token(-10));
    assert.equal(manager.needsToken, true);
    manager.setToken(token(3600));
    assert.equal(manager.needsToken, false);
    assert.equal(changes, 2, 'browsers are told when sharing starts and when it recovers');
  });
});
