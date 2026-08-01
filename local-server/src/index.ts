/**
 * Playmat local dev server.
 *
 * One process, one port (default 8787):
 *   HTTP  /api/*            room API (same contract as the deployed Lambda)
 *   WS    /event/realtime   AppSync Events wire protocol (connection_init/ack,
 *                           subscribe, publish, data, ka)
 *
 * Delivery is faithful: every published event fans out, in order, to every
 * subscriber of the channel. No artificial drops or reordering — the client
 * is *written* to tolerate those (seq numbers + absolute state), but the dev
 * server never manufactures them.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  type HiddenState,
  type JoinRoomResponse,
  type SnapshotResponse,
  type StateEvent,
  assembleSnapshot,
  normalizeRoomCode,
  MAX_EVENTS_PER_PUBLISH,
} from '@playmat/shared';
import { signRoomToken, verifyRoomToken, type RoomClaims } from '@playmat/shared/src/jwt';
import { createRoom, getRoom, joinRoom, listRooms, persistStateEvent, publicSeats, type Room } from './store';

const PORT = Number(process.env.PORT || 8787);
const JWT_KEY = process.env.JWT_KEY || 'playmat-local-dev-key';
const USER_AGENT = 'mtg-playmat/0.1';

// ---------------------------------------------------------------------------
// Pub/sub registry
// ---------------------------------------------------------------------------

interface Subscription {
  ws: WebSocket;
  subId: string;
  channel: string;
}

/** channel -> subscriptions */
const subs = new Map<string, Set<Subscription>>();
/** per-socket bookkeeping for cleanup */
const socketSubs = new WeakMap<WebSocket, Set<Subscription>>();

function subscribe(ws: WebSocket, subId: string, channel: string): void {
  const sub: Subscription = { ws, subId, channel };
  if (!subs.has(channel)) subs.set(channel, new Set());
  subs.get(channel)!.add(sub);
  if (!socketSubs.has(ws)) socketSubs.set(ws, new Set());
  socketSubs.get(ws)!.add(sub);
}

function unsubscribe(ws: WebSocket, subId: string): boolean {
  const mine = socketSubs.get(ws);
  if (!mine) return false;
  for (const sub of mine) {
    if (sub.subId === subId) {
      mine.delete(sub);
      subs.get(sub.channel)?.delete(sub);
      return true;
    }
  }
  return false;
}

function dropSocket(ws: WebSocket): void {
  const mine = socketSubs.get(ws);
  if (!mine) return;
  for (const sub of mine) subs.get(sub.channel)?.delete(sub);
  socketSubs.delete(ws);
}

/** Match subscribers: exact channel or a subscription ending in /* that prefixes it. */
function subscribersFor(channel: string): Subscription[] {
  const out: Subscription[] = [];
  for (const [subChannel, set] of subs) {
    if (subChannel === channel) {
      out.push(...set);
    } else if (subChannel.endsWith('/*') && channel.startsWith(subChannel.slice(0, -1))) {
      out.push(...set);
    }
  }
  return out;
}

function broadcast(channel: string, stringifiedEvents: string[]): void {
  for (const sub of subscribersFor(channel)) {
    if (sub.ws.readyState === WebSocket.OPEN) {
      sub.ws.send(JSON.stringify({ type: 'data', id: sub.subId, event: stringifiedEvents }));
    }
  }
}

/** Server-originated state event: persist + fan out (join roster, join log). */
function serverPublish(room: Room, makeEvents: (nextSeq: () => number) => StateEvent[]): void {
  const events = makeEvents(() => ++room.serverSeq);
  for (const ev of events) persistStateEvent(room, ev);
  broadcast(`/state/${room.code}`, events.map((e) => JSON.stringify(e)));
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  return JSON.parse(raw);
}

function bearerClaims(req: IncomingMessage): RoomClaims | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const token = header.replace(/^Bearer\s+/i, '');
  return verifyRoomToken(token, JWT_KEY);
}

function currentGameId(room: Room): string | null {
  const item = room.board.get('room');
  return item && item.ev.t === 'room' ? item.ev.room.gameId : null;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const parts = path.split('/').filter(Boolean); // ['api', ...]

  // POST /api/rooms
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
    const body = await readBody(req);
    const name = String(body.name || 'Player').slice(0, 40);
    const room = createRoom();
    const join = joinRoom(room, name);
    if (join.spectator) throw new Error('unreachable'); // fresh room always has seats
    const record = join.record;
    const token = signRoomToken({ rc: room.code, pid: record.playerId, seat: record.seat }, JWT_KEY);
    serverPublish(room, (next) => [
      { t: 'seats', g: '*', by: 'server', seq: next(), seats: publicSeats(room) },
      {
        t: 'log', g: '*', by: 'server', seq: next(),
        entry: { kind: 'join', text: `${record.name} created the room`, ts: Date.now() },
      },
    ]);
    const resp: JoinRoomResponse = {
      roomCode: room.code,
      playerId: record.playerId,
      seat: record.seat,
      token,
      rejoinKey: record.rejoinKey,
      players: publicSeats(room),
    };
    send(res, 200, resp);
    return;
  }

  // /api/rooms/{code}/...
  if (parts[1] === 'rooms' && parts.length >= 4) {
    const code = normalizeRoomCode(parts[2]);
    const room = getRoom(code);
    if (!room) {
      send(res, 404, { error: `Room ${code} not found` });
      return;
    }
    const action = parts[3];

    if (req.method === 'POST' && action === 'join') {
      const body = await readBody(req);
      const name = String(body.name || 'Player').slice(0, 40);
      const join = joinRoom(room, name, body.playerId, body.rejoinKey);
      const seat = join.spectator ? null : (join.record as any).seat;
      const token = signRoomToken(
        { rc: room.code, pid: join.record.playerId, seat, spec: join.spectator || undefined },
        JWT_KEY
      );
      if (!join.spectator && !join.rejoined) {
        serverPublish(room, (next) => [
          { t: 'seats', g: '*', by: 'server', seq: next(), seats: publicSeats(room) },
          {
            t: 'log', g: '*', by: 'server', seq: next(),
            entry: { kind: 'join', text: `${name} joined`, ts: Date.now() },
          },
        ]);
      }
      const resp: JoinRoomResponse = {
        roomCode: room.code,
        playerId: join.record.playerId,
        seat,
        token,
        rejoinKey: join.record.rejoinKey,
        players: publicSeats(room),
      };
      send(res, 200, resp);
      return;
    }

    if (req.method === 'GET' && action === 'snapshot') {
      const claims = bearerClaims(req);
      if (!claims || claims.rc !== room.code) {
        send(res, 401, { error: 'Invalid token' });
        return;
      }
      const base = assembleSnapshot([...room.board.values()], publicSeats(room));
      const hidden = claims.spec ? null : room.hidden.get(claims.pid) ?? null;
      const resp: SnapshotResponse = { roomCode: room.code, ...base, hidden };
      send(res, 200, resp);
      return;
    }

    if (req.method === 'PUT' && action === 'hidden') {
      const claims = bearerClaims(req);
      if (!claims || claims.rc !== room.code || claims.spec) {
        send(res, 401, { error: 'Invalid token' });
        return;
      }
      const body = (await readBody(req)) as HiddenState;
      if (!Array.isArray(body.library) || !Array.isArray(body.hand)) {
        send(res, 400, { error: 'Malformed hidden state' });
        return;
      }
      const cur = room.hidden.get(claims.pid);
      // Same last-writer-wins discipline as board items, plus game-epoch guard.
      const gameId = currentGameId(room);
      if (gameId !== null && body.gameId !== gameId && cur && cur.gameId === gameId) {
        send(res, 409, { error: 'Stale gameId' });
        return;
      }
      if (!cur || body.gameId !== cur.gameId || body.seq >= cur.seq) {
        room.hidden.set(claims.pid, {
          gameId: body.gameId,
          seq: Number(body.seq) || 0,
          library: body.library.map(String),
          hand: body.hand.map(String),
        });
      }
      send(res, 200, { ok: true });
      return;
    }
  }

  // GET /api/archidekt/{deckId} — CORS proxy with a courteous User-Agent
  if (req.method === 'GET' && parts[1] === 'archidekt' && parts[2]) {
    const deckId = parts[2].replace(/[^0-9]/g, '');
    try {
      const upstream = await fetch(`https://archidekt.com/api/decks/${deckId}/`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(text);
    } catch (err) {
      send(res, 502, { error: `Archidekt fetch failed: ${String(err)}` });
    }
    return;
  }

  send(res, 404, { error: `No route: ${req.method} ${path}` });
}

// ---------------------------------------------------------------------------
// WebSocket: AppSync Events wire protocol
// ---------------------------------------------------------------------------

interface WsAuthResult {
  claims: RoomClaims | null;
  error?: string;
}

function authFromMessage(msg: any, connClaims: RoomClaims | null): WsAuthResult {
  const auth = msg.authorization;
  const token: string | undefined = auth?.Authorization ?? auth?.authorization;
  if (token) {
    const claims = verifyRoomToken(String(token).replace(/^Bearer\s+/i, ''), JWT_KEY);
    return claims ? { claims } : { claims: null, error: 'Invalid token' };
  }
  if (connClaims) return { claims: connClaims };
  return { claims: null, error: 'Missing authorization' };
}

/** channel "/state/CODE/..." -> {namespace, roomCode} */
function parseChannel(channel: string): { namespace: string; roomCode: string } | null {
  const segs = channel.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  return { namespace: segs[0], roomCode: segs[1].replace(/\*$/, '') };
}

function wsError(ws: WebSocket, type: string, id: string | undefined, message: string): void {
  ws.send(JSON.stringify({ type, id, errors: [{ errorType: 'UnauthorizedException', message }] }));
}

function handleWsMessage(ws: WebSocket, connClaims: RoomClaims | null, raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.type) {
    case 'connection_init':
      ws.send(JSON.stringify({ type: 'connection_ack', connectionTimeoutMs: 300000 }));
      return;

    case 'subscribe': {
      const { claims, error } = authFromMessage(msg, connClaims);
      const parsed = typeof msg.channel === 'string' ? parseChannel(msg.channel) : null;
      if (!parsed || !['state', 'ephemeral'].includes(parsed.namespace)) {
        wsError(ws, 'subscribe_error', msg.id, 'Unknown channel namespace');
        return;
      }
      if (!claims || claims.rc !== parsed.roomCode) {
        wsError(ws, 'subscribe_error', msg.id, error ?? 'Channel not authorized for this room token');
        return;
      }
      subscribe(ws, msg.id, msg.channel);
      ws.send(JSON.stringify({ type: 'subscribe_success', id: msg.id }));
      return;
    }

    case 'unsubscribe':
      if (unsubscribe(ws, msg.id)) {
        ws.send(JSON.stringify({ type: 'unsubscribe_success', id: msg.id }));
      } else {
        wsError(ws, 'unsubscribe_error', msg.id, `Unknown operation id ${msg.id}`);
      }
      return;

    case 'publish': {
      const { claims, error } = authFromMessage(msg, connClaims);
      const parsed = typeof msg.channel === 'string' ? parseChannel(msg.channel) : null;
      if (!parsed || !['state', 'ephemeral'].includes(parsed.namespace)) {
        wsError(ws, 'publish_error', msg.id, 'Unknown channel namespace');
        return;
      }
      if (!claims || claims.rc !== parsed.roomCode) {
        wsError(ws, 'publish_error', msg.id, error ?? 'Channel not authorized for this room token');
        return;
      }
      if (!Array.isArray(msg.events) || msg.events.length === 0 || msg.events.length > MAX_EVENTS_PER_PUBLISH) {
        wsError(ws, 'publish_error', msg.id, `events must be 1..${MAX_EVENTS_PER_PUBLISH} stringified JSON values`);
        return;
      }
      if (claims.spec && parsed.namespace === 'state') {
        wsError(ws, 'publish_error', msg.id, 'Spectators cannot publish state');
        return;
      }

      const room = getRoom(parsed.roomCode);
      if (!room) {
        wsError(ws, 'publish_error', msg.id, 'Room not found');
        return;
      }

      const accepted: string[] = [];
      const successful: { identifier: string; index: number }[] = [];
      const failed: { identifier: string; index: number; message?: string }[] = [];

      msg.events.forEach((s: unknown, index: number) => {
        try {
          const ev = JSON.parse(String(s));
          // S-3: events must be attributed to the sender ("server" is reserved).
          if (parsed.namespace === 'state') {
            const stateEv = ev as StateEvent;
            if (stateEv.by !== claims.pid) throw new Error('by must equal your playerId');
            persistStateEvent(room, stateEv);
          } else if (ev.by !== claims.pid) {
            throw new Error('by must equal your playerId');
          }
          accepted.push(String(s));
          successful.push({ identifier: `${msg.id}-${index}`, index });
        } catch (e) {
          failed.push({ identifier: `${msg.id}-${index}`, index, message: String(e) });
        }
      });

      if (accepted.length > 0) broadcast(msg.channel, accepted);
      ws.send(JSON.stringify({ type: 'publish_success', id: msg.id, successful, failed }));
      return;
    }

    default:
      // Ignore unknown message types, like the real endpoint ignores pings.
      return;
  }
}

// ---------------------------------------------------------------------------
// Wire it together
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  try {
    if (path.startsWith('/api/')) {
      await handleApi(req, res, path);
      return;
    }
    if (path === '/') {
      const roomList = listRooms().map((r) => ({
        code: r.code,
        players: r.seats.map((s) => s.name),
        boardItems: r.board.size,
        age: `${Math.round((Date.now() - r.createdAt) / 60000)}m`,
      }));
      send(res, 200, { service: 'playmat-local-server', rooms: roomList });
      return;
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, 500, { error: String(err) });
  }
});

const wss = new WebSocketServer({
  server,
  path: '/event/realtime',
  handleProtocols: (protocols) => {
    // AppSync requires 'aws-appsync-event-ws' plus a 'header-<b64url>' auth
    // protocol. Echo back the former, mine the latter for credentials.
    if (protocols.has('aws-appsync-event-ws')) return 'aws-appsync-event-ws';
    return protocols.values().next().value ?? false;
  },
});

wss.on('connection', (ws, req) => {
  // Connection-level auth from the header-* subprotocol.
  let connClaims: RoomClaims | null = null;
  const offered = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim());
  const headerProto = offered.find((p) => p.startsWith('header-'));
  if (headerProto) {
    try {
      const b64 = headerProto.slice('header-'.length).replace(/-/g, '+').replace(/_/g, '/');
      const decoded = JSON.parse(Buffer.from(b64, 'base64').toString());
      const token: string | undefined = decoded.Authorization ?? decoded.authorization;
      if (token) connClaims = verifyRoomToken(String(token).replace(/^Bearer\s+/i, ''), JWT_KEY);
    } catch {
      // fall through: per-operation auth can still succeed
    }
  }

  ws.on('message', (data) => handleWsMessage(ws, connClaims, data.toString()));
  ws.on('close', () => dropSocket(ws));
  ws.on('error', () => dropSocket(ws));
});

// Keep-alive: AppSync sends ka every ~60s; we do the same.
setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'ka' }));
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`[playmat] local server on http://localhost:${PORT}`);
  console.log(`[playmat]   room API:  http://localhost:${PORT}/api`);
  console.log(`[playmat]   realtime:  ws://localhost:${PORT}/event/realtime`);
});
