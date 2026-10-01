import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  keyFingerprint,
  pairingLink,
  parsePairingHash,
  verifyRoomEnvelope,
  verifyRoomSnapshot,
  type AgentEvent,
  type RoomSharing,
} from '@agentnauts/shared';
import { loadOrCreateIdentity } from './identity';
import { ProjectAliases, signRoomContent, toRoomContent, toRoomSnapshot } from './room';

const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'an-')), name);
const code = () => generateRoomCode((n) => webcrypto.getRandomValues(new Uint32Array(n)));
const ROOM_ID = '5f0c2d4e-8b1a-4c3d-9e2f-1a2b3c4d5e6f';
const makeRoom = (overrides: Partial<RoomSharing> = {}): RoomSharing => ({
  roomId: ROOM_ID,
  name: 'bob',
  shareDetails: false,
  ...overrides,
});

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

  it('does not say which MCP services you use unless details are shared', () => {
    const mcp = { ...event, toolName: 'mcp__acme_billing__refund_customer' };
    assert.equal(toRoomContent(mcp, settings, 'KEY', new ProjectAliases()).event.toolName, 'mcp__tool');
    assert.equal(toRoomContent(mcp, makeRoom({ shareDetails: true }), 'KEY', new ProjectAliases()).event.toolName, mcp.toolName);
  });

  it('never puts readable commands on the wire', () => {
    // Supabase's gateway refuses requests whose text looks like an attack, and
    // shell commands and SQL often do. The signed content travels encoded.
    const alice = loadOrCreateIdentity(tempFile('alice.json'));
    const risky = { ...event, detail: `curl -s localhost | node -e "process.stdin"; select * from users; drop table users` };
    const envelope = signRoomContent(toRoomContent(risky, makeRoom({ shareDetails: true }), alice.publicKey, new ProjectAliases()), alice);
    const wire = JSON.stringify(envelope);
    assert.match(envelope.data, /^[A-Za-z0-9_-]+$/);
    for (const word of ['curl', 'select', 'drop table', 'acme-payments']) assert.ok(!wire.includes(word), word);
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
    const edited = Buffer.from(envelope.data, 'base64url').toString('utf8').replace('"alice"', '"eve"');
    const tampered = { ...envelope, data: Buffer.from(edited, 'utf8').toString('base64url') };
    assert.equal(await verifyRoomEnvelope(tampered, room), null);

    // A genuine message can't be replayed into another room.
    assert.equal(await verifyRoomEnvelope(envelope, '00000000-0000-4000-8000-000000000000'), null);
  });

  it('signs snapshots the same way, with details hidden unless shared', async () => {
    const alice = loadOrCreateIdentity(tempFile('alice.json'));
    const mallory = loadOrCreateIdentity(tempFile('mallory.json'));
    const snapshot = toRoomSnapshot([event, { ...event, id: 'e2', sessionId: 's2' }], makeRoom({ name: 'alice' }), alice.publicKey, new ProjectAliases());
    const envelope = signRoomContent(snapshot, alice);

    const verified = await verifyRoomSnapshot(envelope, ROOM_ID);
    assert.equal(verified?.events.length, 2);
    assert.ok(verified!.events.every((e) => e.detail === undefined && e.sessionName === 'project 1'));
    assert.equal(await verifyRoomSnapshot(signRoomContent(snapshot, mallory), ROOM_ID), null);
    assert.equal(await verifyRoomSnapshot(envelope, '00000000-0000-4000-8000-000000000000'), null);
    // One kind of message can't pass for the other.
    assert.equal(await verifyRoomEnvelope(envelope, ROOM_ID), null);
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

describe('pairing links', () => {
  const key = loadOrCreateIdentity(tempFile('id.json')).publicKey;

  it('carries the key in the fragment, so it never reaches the web server', () => {
    const link = pairingLink('https://app.example/', { key, device: "Olive's  MacBook" });
    const url = new URL(link);
    assert.equal(url.origin + url.pathname, 'https://app.example/');
    assert.equal(url.search, '');
    assert.deepEqual(parsePairingHash(url.hash), { key, device: "Olive's MacBook" });
  });

  it('ignores anything that is not a key', () => {
    assert.equal(parsePairingHash(''), null);
    assert.equal(parsePairingHash('#connect=short&device=x'), null);
    assert.equal(parsePairingHash(`#device=x`), null);
    assert.deepEqual(parsePairingHash(`#connect=${key}`), { key, device: '' });
  });
});
