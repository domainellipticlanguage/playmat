#!/usr/bin/env node
/**
 * Smoke test against the DEPLOYED stack (reads infra/outputs.json):
 * two players join a real room, talk over real AppSync Events, and verify
 * fan-out, persistence, snapshots, hidden-zone privacy, and spectator limits.
 * Cleans up nothing — rooms expire via TTL.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputs = JSON.parse(readFileSync(join(root, 'infra', 'outputs.json'), 'utf8')).Playmat;
const API = outputs.ApiBase;
const REALTIME = outputs.EventsRealtime;
const EVENTS_HOST = outputs.EventsHttpHost;

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? '✓' : '✗ FAIL:'} ${label}`);
  if (!cond) failures++;
};

const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function post(path, body, token) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(REALTIME, [
      `header-${b64url({ host: EVENTS_HOST, Authorization: token })}`,
      'aws-appsync-event-ws',
    ]);
    const received = [];
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      received.push(msg);
      if (msg.type === 'connection_ack') resolve({ ws, received, token });
    };
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? e}`));
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}

function subscribe(client, channel) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const check = setInterval(() => {
      for (const m of client.received) {
        if (m.id !== id) continue;
        if (m.type === 'subscribe_success') { clearInterval(check); resolve(true); }
        if (m.type === 'subscribe_error') { clearInterval(check); resolve(false); }
      }
    }, 30);
    client.ws.send(JSON.stringify({ type: 'subscribe', id, channel, authorization: { Authorization: client.token } }));
    setTimeout(() => { clearInterval(check); reject(new Error('subscribe timeout')); }, 8000);
  });
}

function publish(client, channel, events) {
  const id = crypto.randomUUID();
  client.ws.send(JSON.stringify({
    type: 'publish', id, channel,
    events: events.map((e) => JSON.stringify(e)),
    authorization: { Authorization: client.token },
  }));
  return id;
}

const waitFor = (getter, ms = 8000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = getter();
      if (hit !== undefined) { clearInterval(iv); resolve(hit); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('waitFor timeout')); }
    }, 40);
  });

const dataEvents = (client) => {
  const out = [];
  for (const m of client.received) {
    if (m.type !== 'data') continue;
    const items = Array.isArray(m.event) ? m.event : [m.event];
    for (const item of items) {
      try { out.push(typeof item === 'string' ? JSON.parse(item) : item); } catch {}
    }
  }
  return out;
};

// ---------------------------------------------------------------------------

console.log(`API: ${API}\nRealtime: ${REALTIME}\n`);

const t0 = Date.now();
const alice = (await post('/rooms', { name: 'SmokeAlice' })).json;
check(`room created: ${alice.roomCode} (${Date.now() - t0}ms)`, !!alice.roomCode && alice.seat === 0);

const bob = (await post(`/rooms/${alice.roomCode}/join`, { name: 'SmokeBob' })).json;
check(`bob seated at ${bob.seat}`, bob.seat === 1);

const chan = `/state/${alice.roomCode}`;
const a = await connect(alice.token);
const b = await connect(bob.token);
check('both websockets connected + acked', true);

check('alice subscribes to state', await subscribe(a, chan));
check('bob subscribes to state', await subscribe(b, chan));
check('bob subscribes to ephemeral', await subscribe(b, `/ephemeral/${alice.roomCode}`));
check('cross-room subscribe denied', !(await subscribe(a, '/state/ZZZZ9')));

// The seats roster the Lambda published on join should be persisted:
const snap0 = (await (await fetch(`${API}/rooms/${alice.roomCode}/snapshot`, { headers: { Authorization: `Bearer ${alice.token}` } })).json());
check('snapshot includes both seats', snap0.players?.length === 2);
check('seats event persisted via IAM publish', !!snap0.seqs?.seats);

// Publish a card event; verify fan-out latency + persistence.
const t1 = Date.now();
publish(a, chan, [{
  t: 'card', g: 'smoke-game', by: alice.playerId, seq: 1,
  card: { guid: 'smoke-card', zone: 'battlefield', ownerId: alice.playerId, controllerId: alice.playerId, x: 111, y: 222, tapped: false, faceDown: false, faceIndex: 0, rotIndex: 0, counters: {}, order: 0 },
}, { t: 'room', g: 'smoke-game', by: alice.playerId, seq: 1, room: { gameId: 'smoke-game', turnPlayerId: null } }]);
const got = await waitFor(() => dataEvents(b).find((e) => e.t === 'card' && e.card?.guid === 'smoke-card'));
check(`bob received card event via AppSync (${Date.now() - t1}ms publish→deliver)`, got.card.x === 111);

// S-3: impersonated event must be dropped (not broadcast).
publish(b, chan, [{ t: 'card', g: 'smoke-game', by: alice.playerId, seq: 5, card: { ...got.card, x: 999 } }]);
await new Promise((r) => setTimeout(r, 2500));
check('impersonated publish not broadcast', !dataEvents(a).some((e) => e.card?.x === 999));

// Persistence: snapshot reflects the card.
const snap1 = (await (await fetch(`${API}/rooms/${alice.roomCode}/snapshot`, { headers: { Authorization: `Bearer ${bob.token}` } })).json());
check('board item persisted via DDB handler', snap1.cards?.some((c) => c.guid === 'smoke-card' && c.x === 111));
check('impersonated event not persisted', !snap1.cards?.some((c) => c.x === 999));

// Hidden zones: private to owner.
await fetch(`${API}/rooms/${alice.roomCode}/hidden`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
  body: JSON.stringify({ gameId: 'smoke-game', seq: 1, library: ['h1', 'h2'], hand: ['h3'] }),
});
const snapA = (await (await fetch(`${API}/rooms/${alice.roomCode}/snapshot`, { headers: { Authorization: `Bearer ${alice.token}` } })).json());
const snapB = (await (await fetch(`${API}/rooms/${alice.roomCode}/snapshot`, { headers: { Authorization: `Bearer ${bob.token}` } })).json());
check('owner sees own hidden zones', snapA.hidden?.library?.length === 2);
check("peer cannot see owner's hidden zones", !snapB.hidden?.library?.includes('h1'));

// Rejoin (R-6).
const rejoin = (await post(`/rooms/${alice.roomCode}/join`, { name: 'SmokeAlice', playerId: alice.playerId, rejoinKey: alice.rejoinKey })).json;
check('rejoin resumes seat 0', rejoin.seat === 0 && rejoin.playerId === alice.playerId);

// Spectator (room full → seat null, cannot publish state).
await post(`/rooms/${alice.roomCode}/join`, { name: 'P3' });
await post(`/rooms/${alice.roomCode}/join`, { name: 'P4' });
const spec = (await post(`/rooms/${alice.roomCode}/join`, { name: 'Spec' })).json;
check('fifth joiner is a spectator', spec.seat === null);
const s = await connect(spec.token);
check('spectator can subscribe', await subscribe(s, chan));
const specPubId = publish(s, chan, [{ t: 'room', g: 'smoke-game', by: spec.playerId, seq: 99, room: { gameId: 'evil', turnPlayerId: null } }]);
const specResult = await waitFor(() => s.received.find((m) => m.id === specPubId && (m.type === 'publish_error' || m.type === 'publish_success')));
check('spectator state publish rejected', specResult.type === 'publish_error');

// Bad token.
const badJoin = await fetch(`${API}/rooms/${alice.roomCode}/snapshot`, { headers: { Authorization: 'Bearer nope' } });
check('bad token rejected on snapshot', badJoin.status === 401);

a.ws.close(); b.ws.close(); s.ws.close();

console.log(failures === 0 ? '\nALL AWS SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
