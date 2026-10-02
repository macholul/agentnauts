/**
 * Checks this computer's cloud setup end to end against the real Supabase
 * project: `npm run check:cloud -w server`.
 *
 * It signs in as this computer (never as you), sends a short test agent to
 * every room the computer is connected to, and confirms the token is refused
 * everywhere else.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROOM_EVENT, keyFingerprint, makeId, roomTopic, type AgentEvent } from '@agentnauts/shared';
import { fetchConnections, publish } from './cloud';
import { readSettings } from './config';
import { loadOrCreateIdentity } from './identity';
import { ProjectAliases, signRoomContent, toRoomContent } from './room';

const { cloud } = readSettings();
if (!cloud) {
  console.error('No Supabase project configured (see shared/src/cloud.ts).');
  process.exit(1);
}
const identity = loadOrCreateIdentity();
let failed = 0;
const check = (ok: boolean, text: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`);
};

console.log(`This computer: ${identity.publicKey} (ID ${keyFingerprint(identity.publicKey)})`);
console.log(`Project:       ${cloud.url}\n`);

const auth = await fetchConnections(cloud, identity);
if (!auth.ok) {
  check(false, `agent-auth answered ${auth.status}: ${auth.error}`);
  process.exit(1);
}
check(true, `agent-auth accepted this computer's proof (${auth.value.length} room(s))`);
if (auth.value.length === 0) {
  console.log('\nThis computer is not connected to any room yet, so there is nothing to send.');
  process.exit(0);
}

for (const connection of auth.value) {
  console.log(`\nRoom "${connection.roomName}" as ${connection.name}${connection.personal ? ' (personal)' : ''}`);
  const aliases = new ProjectAliases();
  const sessionId = `check-${randomUUID()}`;
  const send = (type: AgentEvent['type'], toolName?: string) => {
    const event: AgentEvent = {
      id: makeId(),
      sessionId,
      type,
      ...(toolName ? { toolName } : {}),
      sessionName: 'cloud-check',
      timestamp: Date.now(),
      source: 'hooks',
    };
    return publish(cloud, connection, ROOM_EVENT, signRoomContent(toRoomContent(event, connection, identity.publicKey, aliases), identity));
  };

  const first = await send('session_start');
  check(first.ok, first.ok ? 'token may send to its own room' : `could not send to its own room (${first.status}: ${first.error})`);

  // Anywhere else must be refused: another room, and a topic that is not a room.
  const elsewhere = await publish(cloud, connection, ROOM_EVENT, { probe: true }, fetch, roomTopic(randomUUID()));
  check(!elsewhere.ok, elsewhere.ok ? 'token was ACCEPTED in another room' : `refused in another room (${elsewhere.status})`);
  const stray = await publish(cloud, connection, ROOM_EVENT, { probe: true }, fetch, 'some-other-topic');
  check(!stray.ok, stray.ok ? 'token was ACCEPTED on an unrelated topic' : `refused on an unrelated topic (${stray.status})`);

  // The token is not a user: no rooms visible, no room operations.
  const rest = (path: string, init: RequestInit = {}) =>
    fetch(`${cloud.url}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: cloud.key, Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    });
  const rooms = await rest('rooms?select=id');
  const visible = rooms.ok ? ((await rooms.json()) as unknown[]).length : 0;
  check(visible === 0, visible === 0 ? 'token sees no rooms' : `token can read ${visible} room(s)`);
  const create = await rest('rpc/create_room', {
    method: 'POST',
    body: JSON.stringify({ p_code: 'crew-zzzz-zzzz-zzzz', p_name: 'x', p_display_name: 'x' }),
  });
  check(!create.ok, create.ok ? 'token could CREATE A ROOM' : `token cannot create a room (${create.status})`);

  if (first.ok) {
    console.log('      sending a test astronaut: scanner, drill, fabricator, then it leaves (about 20s)');
    for (const tool of ['Read', 'Bash', 'Edit']) {
      await send('tool_start', tool);
      await sleep(6000);
    }
    await send('session_end');
  }
}

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
