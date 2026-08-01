/**
 * End-to-end protocol test against a real local-server process: the full
 * game flow a browser client performs — join, subscribe, deck import with
 * epochs, hidden zones, game reset filtering, and seat rejoin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SnapshotResponse, StateEvent } from '@playmat/shared';

const PORT = 18787;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;

const b64url = (obj: unknown) =>
  Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function getSnapshot(code: string, token: string): Promise<SnapshotResponse> {
  const res = await fetch(`${BASE}/api/rooms/${code}/snapshot`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok).toBe(true);
  return res.json() as Promise<SnapshotResponse>;
}

interface TestClient {
  ws: WebSocket;
  received: any[];
  publish: (channel: string, events: unknown[]) => void;
  subscribe: (channel: string) => Promise<void>;
  close: () => void;
}

function connect(token: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/event/realtime`, [
      `header-${b64url({ host: `localhost:${PORT}`, Authorization: token })}`,
      'aws-appsync-event-ws',
    ]);
    const received: any[] = [];
    const client: TestClient = {
      ws,
      received,
      publish: (channel, events) =>
        ws.send(
          JSON.stringify({
            type: 'publish',
            id: crypto.randomUUID(),
            channel,
            events: events.map((e) => JSON.stringify(e)),
            authorization: { Authorization: token },
          })
        ),
      subscribe: (channel) =>
        new Promise<void>((res, rej) => {
          const id = crypto.randomUUID();
          const onMsg = (m: MessageEvent) => {
            const msg = JSON.parse(m.data as string);
            if (msg.id !== id) return;
            if (msg.type === 'subscribe_success') res();
            if (msg.type === 'subscribe_error') rej(new Error(JSON.stringify(msg.errors)));
          };
          ws.addEventListener('message', onMsg);
          ws.send(JSON.stringify({ type: 'subscribe', id, channel, authorization: { Authorization: token } }));
        }),
      close: () => ws.close(),
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data as string);
      received.push(msg);
      if (msg.type === 'connection_ack') resolve(client);
    };
    ws.onerror = () => reject(new Error('ws error'));
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
}

const waitFor = <T>(source: any[] | (() => any[]), pred: (m: any) => T | undefined, ms = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const arr = typeof source === 'function' ? source() : source;
      for (const m of arr) {
        const hit = pred(m);
        if (hit !== undefined) {
          clearInterval(iv);
          resolve(hit);
          return;
        }
      }
      if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('waitFor timeout'));
      }
    }, 15);
  });

/** Extract parsed state events delivered to a client. */
function stateEventsOf(client: TestClient): StateEvent[] {
  const out: StateEvent[] = [];
  for (const m of client.received) {
    if (m.type !== 'data') continue;
    const items = Array.isArray(m.event) ? m.event : [m.event];
    for (const item of items) {
      try {
        out.push(typeof item === 'string' ? JSON.parse(item) : item);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

beforeAll(async () => {
  server = spawn('npx', ['tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
  });
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on('data', (d) => String(d).includes('local server on') && resolve());
    server.on('exit', () => reject(new Error('server died')));
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
}, 10000);

afterAll(() => {
  server?.kill();
});

describe('playmat protocol end-to-end', () => {
  it('plays through a full session', async () => {
    // -- Join ----------------------------------------------------------------
    const alice = await post<any>('/api/rooms', { name: 'Alice' });
    const bob = await post<any>(`/api/rooms/${alice.roomCode}/join`, { name: 'Bob' });
    expect(alice.seat).toBe(0);
    expect(bob.seat).toBe(1);
    const chan = `/state/${alice.roomCode}`;

    const a = await connect(alice.token);
    const b = await connect(bob.token);
    await a.subscribe(chan);
    await b.subscribe(chan);

    // -- Alice imports a 3-card deck (chunked, with importId) ---------------
    const gameId = 'game-1';
    const importId = 'aaa-1';
    const mk = (n: number) => ({
      guid: `alice-card-${n}`,
      ownerId: alice.playerId,
      sf: { id: `sf-${n}`, name: `Card ${n}`, layout: 'normal', faces: [{ name: `Card ${n}`, img: 'https://x/img.jpg' }] },
    });
    a.publish(chan, [
      { t: 'pool', g: gameId, by: alice.playerId, seq: 1, chunk: 0, nChunks: 1, importId, cards: [mk(1), mk(2), mk(3)] },
      { t: 'room', g: gameId, by: alice.playerId, seq: 1, room: { gameId, turnPlayerId: null } },
      {
        t: 'player', g: gameId, by: alice.playerId, seq: 1,
        player: { playerId: alice.playerId, seat: 0, name: 'Alice', life: 40, counters: {}, commanderDamage: {}, handCount: 0, libraryCount: 3, topRevealed: null },
      },
    ]);

    await waitFor(b.received, (m) => (m.type === 'data' ? true : undefined));
    await waitFor(() => stateEventsOf(b), (e) => (e.t === 'player' ? true : undefined));

    // -- Alice plays a card to the battlefield ------------------------------
    a.publish(chan, [
      {
        t: 'card', g: gameId, by: alice.playerId, seq: 1,
        card: { guid: 'alice-card-1', zone: 'battlefield', ownerId: alice.playerId, controllerId: alice.playerId, x: 1200, y: 1600, tapped: false, faceDown: false, faceIndex: 0, rotIndex: 0, counters: {}, order: 0 },
      },
    ]);
    const seen = await waitFor(() => stateEventsOf(b), (e) => (e.t === 'card' && e.card.guid === 'alice-card-1' ? e : undefined));
    expect(seen.card.x).toBe(1200);

    // -- Bob taps Alice's card (honor system) -------------------------------
    b.publish(chan, [
      { t: 'card', g: gameId, by: bob.playerId, seq: 2, card: { ...seen.card, tapped: true } },
    ]);
    await waitFor(() => stateEventsOf(a), (e) => (e.t === 'card' && e.card.guid === 'alice-card-1' && e.card.tapped ? true : undefined));

    // -- Snapshot state matches ---------------------------------------------
    let snap = await getSnapshot(alice.roomCode, bob.token);
    expect(snap.cards).toHaveLength(1);
    expect(snap.cards[0].tapped).toBe(true);
    expect(snap.pools).toHaveLength(3);
    expect(snap.poolImports[alice.playerId]).toBe(importId);
    expect(snap.seqs['card#alice-card-1'].seq).toBe(2);
    expect(snap.room?.gameId).toBe(gameId);

    // -- Hidden state persists and stays private ----------------------------
    await fetch(`${BASE}/api/rooms/${alice.roomCode}/hidden`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ gameId, seq: 3, library: ['alice-card-2', 'alice-card-3'], hand: [] }),
    });
    const aliceSnap = await getSnapshot(alice.roomCode, alice.token);
    expect(aliceSnap.hidden?.library).toEqual(['alice-card-2', 'alice-card-3']);
    const bobSnap = await getSnapshot(alice.roomCode, bob.token);
    expect(bobSnap.hidden?.library ?? []).not.toContain('alice-card-2');

    // -- Re-import: a NEW importId fully replaces Alice's pool --------------
    const importId2 = 'bbb-2';
    const gameId2 = 'game-2';
    a.publish(chan, [
      {
        t: 'pool', g: gameId2, by: alice.playerId, seq: 2, chunk: 0, nChunks: 1, importId: importId2,
        cards: [{ guid: 'alice-new-1', ownerId: alice.playerId, sf: { id: 'sf-n1', name: 'New Card', layout: 'normal', faces: [{ name: 'New Card', img: 'https://x/n.jpg' }] } }],
      },
      { t: 'room', g: gameId2, by: alice.playerId, seq: 2, room: { gameId: gameId2, turnPlayerId: null } },
    ]);
    await waitFor(() => stateEventsOf(b), (e) => (e.t === 'room' && e.room.gameId === gameId2 ? true : undefined));

    snap = await getSnapshot(alice.roomCode, bob.token);
    // New game epoch: old battlefield card is filtered out of the snapshot...
    expect(snap.cards).toHaveLength(0);
    // ...and the pool is ONLY the new import (stale chunks dropped).
    expect(snap.pools.map((p) => p.guid)).toEqual(['alice-new-1']);
    expect(snap.room?.gameId).toBe(gameId2);

    // -- Rejoin resumes the same seat (R-6) ---------------------------------
    const rejoined = await post<any>(`/api/rooms/${alice.roomCode}/join`, {
      name: 'Alice',
      playerId: alice.playerId,
      rejoinKey: alice.rejoinKey,
    });
    expect(rejoined.playerId).toBe(alice.playerId);
    expect(rejoined.seat).toBe(0);

    // -- A 5th joiner becomes a spectator and cannot publish state ----------
    await post<any>(`/api/rooms/${alice.roomCode}/join`, { name: 'C' });
    await post<any>(`/api/rooms/${alice.roomCode}/join`, { name: 'D' });
    const spec = await post<any>(`/api/rooms/${alice.roomCode}/join`, { name: 'Eve' });
    expect(spec.seat).toBeNull();
    const e = await connect(spec.token);
    await e.subscribe(chan); // spectators may watch...
    e.publish(chan, [{ t: 'room', g: gameId2, by: spec.playerId, seq: 9, room: { gameId: 'evil', turnPlayerId: null } }]);
    await waitFor(e.received, (m) => (m.type === 'publish_error' ? true : undefined));
    snap = await getSnapshot(alice.roomCode, bob.token);
    expect(snap.room?.gameId).toBe(gameId2); // ...but not touch the board

    a.close();
    b.close();
    e.close();
  }, 20000);
});
