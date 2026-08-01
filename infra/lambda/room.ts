/**
 * Room/session API — one Lambda behind a Function URL.
 * Routes (with or without a leading /api):
 *   POST /rooms                     create room + seat 0
 *   POST /rooms/{code}/join         join / rejoin / spectate
 *   GET  /rooms/{code}/snapshot     full board snapshot (+ own hidden zones)
 *   PUT  /rooms/{code}/hidden       persist own hidden zones
 *   GET  /archidekt/{deckId}        CORS proxy with courteous User-Agent
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { signRoomToken, verifyRoomToken, type RoomClaims } from '../../shared/src/jwt';
import {
  type BoardItem,
  type SeatRecord,
  type StateEvent,
  assembleSnapshot,
  newGuid,
  newRoomCode,
  normalizeRoomCode,
  MAX_SEATS,
} from '../../shared/src/index';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const BOARD_TABLE = process.env.BOARD_TABLE!;
const JWT_KEY = process.env.JWT_KEY!;
const EVENTS_HTTP_HOST = process.env.EVENTS_HTTP_HOST!;
const REGION = process.env.AWS_REGION || 'us-east-1';
const USER_AGENT = 'mtg-playmat/0.1';

const ROOM_TTL_S = 7 * 24 * 3600;
const HIDDEN_TTL_S = 72 * 3600;
const CREATES_PER_HOUR_PER_IP = 30;

interface SeatRecordDb extends SeatRecord {
  rejoinKey: string;
}
interface RoomRecord {
  roomCode: string;
  sk: string;
  createdAt: number;
  seats: SeatRecordDb[];
  serverSeq: number;
  version: number;
  expireAt: number;
}

const json = (statusCode: number, body: unknown): LambdaFunctionURLResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const publicSeats = (room: RoomRecord): SeatRecord[] =>
  room.seats.map(({ rejoinKey: _x, ...rest }) => rest);

// ---------------------------------------------------------------------------
// Publishing to the Events API over HTTP with IAM (SigV4)
// ---------------------------------------------------------------------------

const signer = new SignatureV4({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
  region: REGION,
  service: 'appsync',
  sha256: Sha256,
});

async function publishState(roomCode: string, events: StateEvent[]): Promise<void> {
  const body = JSON.stringify({
    channel: `/state/${roomCode}`,
    events: events.map((e) => JSON.stringify(e)),
  });
  const request = new HttpRequest({
    method: 'POST',
    protocol: 'https:',
    hostname: EVENTS_HTTP_HOST,
    path: '/event',
    headers: { 'content-type': 'application/json', host: EVENTS_HTTP_HOST },
    body,
  });
  const signed = await signer.sign(request);
  const res = await fetch(`https://${EVENTS_HTTP_HOST}/event`, {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body,
  });
  if (!res.ok) {
    console.error('events publish failed', res.status, await res.text());
  }
}

// ---------------------------------------------------------------------------
// Room record helpers
// ---------------------------------------------------------------------------

async function getRoom(roomCode: string): Promise<RoomRecord | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: ROOMS_TABLE, Key: { roomCode, sk: 'room' } })
  );
  return (res.Item as RoomRecord) ?? null;
}

async function saveRoom(room: RoomRecord, expectedVersion: number | null): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: ROOMS_TABLE,
        Item: { ...room, version: (expectedVersion ?? 0) + 1 },
        ConditionExpression:
          expectedVersion === null ? 'attribute_not_exists(roomCode)' : '#v = :v',
        ...(expectedVersion !== null
          ? { ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': expectedVersion } }
          : {}),
      })
    );
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function rateLimitOk(ip: string): Promise<boolean> {
  const hour = new Date().toISOString().slice(0, 13);
  const key = { roomCode: `ip#${ip}`, sk: `hour#${hour}` };
  const res = await ddb.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: key,
      UpdateExpression: 'ADD #n :one SET expireAt = if_not_exists(expireAt, :exp)',
      ExpressionAttributeNames: { '#n': 'n' },
      ExpressionAttributeValues: { ':one': 1, ':exp': Math.floor(Date.now() / 1000) + 7200 },
      ReturnValues: 'ALL_NEW',
    })
  );
  return ((res.Attributes?.n as number) ?? 0) <= CREATES_PER_HOUR_PER_IP;
}

function bearerClaims(event: LambdaFunctionURLEvent): RoomClaims | null {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!header) return null;
  return verifyRoomToken(header.replace(/^Bearer\s+/i, ''), JWT_KEY);
}

async function announceJoin(room: RoomRecord, text: string): Promise<number> {
  const seq1 = room.serverSeq + 1;
  const seq2 = room.serverSeq + 2;
  const events: StateEvent[] = [
    { t: 'seats', g: '*', by: 'server', seq: seq1, seats: publicSeats(room) },
    { t: 'log', g: '*', by: 'server', seq: seq2, entry: { kind: 'join', text, ts: Date.now() } },
  ];
  await publishState(room.roomCode, events);
  return seq2;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function createRoom(body: any, ip: string): Promise<LambdaFunctionURLResult> {
  if (!(await rateLimitOk(ip))) return json(429, { error: 'Too many rooms created; try later.' });
  const name = String(body.name || 'Player').slice(0, 40);
  let room: RoomRecord | null = null;
  for (let attempt = 0; attempt < 4 && !room; attempt++) {
    const candidate: RoomRecord = {
      roomCode: newRoomCode(),
      sk: 'room',
      createdAt: Date.now(),
      seats: [],
      serverSeq: 0,
      version: 0,
      expireAt: Math.floor(Date.now() / 1000) + ROOM_TTL_S,
    };
    const record: SeatRecordDb = {
      playerId: newGuid(),
      seat: 0,
      name,
      joinedAt: Date.now(),
      rejoinKey: newGuid(),
    };
    candidate.seats.push(record);
    candidate.serverSeq = 2;
    if (await saveRoom(candidate, null)) room = candidate;
  }
  if (!room) return json(500, { error: 'Could not allocate a room code' });
  const record = room.seats[0];
  await announceJoin(room, `${name} created the room`);
  return json(200, {
    roomCode: room.roomCode,
    playerId: record.playerId,
    seat: 0,
    token: signRoomToken({ rc: room.roomCode, pid: record.playerId, seat: 0 }, JWT_KEY, ROOM_TTL_S),
    rejoinKey: record.rejoinKey,
    players: publicSeats(room),
  });
}

async function joinRoom(roomCode: string, body: any): Promise<LambdaFunctionURLResult> {
  const name = String(body.name || 'Player').slice(0, 40);

  for (let attempt = 0; attempt < 4; attempt++) {
    const room = await getRoom(roomCode);
    if (!room) return json(404, { error: `Room ${roomCode} not found` });

    // Rejoin: same playerId + rejoinKey resumes the seat (R-6).
    const existing =
      body.playerId && body.rejoinKey
        ? room.seats.find((s) => s.playerId === body.playerId && s.rejoinKey === body.rejoinKey)
        : undefined;
    if (existing) {
      return json(200, {
        roomCode,
        playerId: existing.playerId,
        seat: existing.seat,
        token: signRoomToken({ rc: roomCode, pid: existing.playerId, seat: existing.seat }, JWT_KEY, ROOM_TTL_S),
        rejoinKey: existing.rejoinKey,
        players: publicSeats(room),
      });
    }

    if (room.seats.length >= MAX_SEATS) {
      // Full: join as spectator (no seat, read-only on state).
      const playerId = newGuid();
      return json(200, {
        roomCode,
        playerId,
        seat: null,
        token: signRoomToken({ rc: roomCode, pid: playerId, seat: null, spec: true }, JWT_KEY, ROOM_TTL_S),
        rejoinKey: newGuid(),
        players: publicSeats(room),
      });
    }

    const taken = new Set(room.seats.map((s) => s.seat));
    let seat = 0;
    while (taken.has(seat)) seat++;
    const record: SeatRecordDb = {
      playerId: newGuid(),
      seat,
      name,
      joinedAt: Date.now(),
      rejoinKey: newGuid(),
    };
    const updated: RoomRecord = {
      ...room,
      seats: [...room.seats, record].sort((a, b) => a.seat - b.seat),
      serverSeq: room.serverSeq + 2,
      expireAt: Math.floor(Date.now() / 1000) + ROOM_TTL_S,
    };
    if (!(await saveRoom(updated, room.version))) continue; // lost a race; retry

    await announceJoin(updated, `${name} joined`);
    return json(200, {
      roomCode,
      playerId: record.playerId,
      seat,
      token: signRoomToken({ rc: roomCode, pid: record.playerId, seat }, JWT_KEY, ROOM_TTL_S),
      rejoinKey: record.rejoinKey,
      players: publicSeats(updated),
    });
  }
  return json(409, { error: 'Room is busy; try again' });
}

async function getSnapshot(roomCode: string, claims: RoomClaims): Promise<LambdaFunctionURLResult> {
  const room = await getRoom(roomCode);
  if (!room) return json(404, { error: `Room ${roomCode} not found` });

  const items: BoardItem[] = [];
  let hidden: unknown = null;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: BOARD_TABLE,
        KeyConditionExpression: 'roomCode = :rc',
        ExpressionAttributeValues: { ':rc': roomCode },
        ExclusiveStartKey: lastKey,
      })
    );
    for (const item of page.Items ?? []) {
      const sk = String(item.sk);
      if (sk.startsWith('hidden#')) {
        if (sk === `hidden#${claims.pid}` && !claims.spec) hidden = item.state ?? null;
        continue;
      }
      items.push(item as unknown as BoardItem);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  const base = assembleSnapshot(items, publicSeats(room));
  return json(200, { roomCode, ...base, hidden });
}

async function putHidden(roomCode: string, claims: RoomClaims, body: any): Promise<LambdaFunctionURLResult> {
  if (claims.spec) return json(403, { error: 'Spectators have no hidden zones' });
  if (!Array.isArray(body.library) || !Array.isArray(body.hand)) {
    return json(400, { error: 'Malformed hidden state' });
  }
  const state = {
    gameId: String(body.gameId ?? ''),
    seq: Number(body.seq) || 0,
    library: body.library.map(String),
    hand: body.hand.map(String),
  };
  // Last-writer-wins guarded by seq (same discipline as board subjects).
  try {
    await ddb.send(
      new PutCommand({
        TableName: BOARD_TABLE,
        Item: {
          roomCode,
          sk: `hidden#${claims.pid}`,
          state,
          seq: state.seq,
          gameId: state.gameId,
          expireAt: Math.floor(Date.now() / 1000) + HIDDEN_TTL_S,
        },
        ConditionExpression:
          'attribute_not_exists(roomCode) OR seq < :seq OR gameId <> :g',
        ExpressionAttributeValues: { ':seq': state.seq, ':g': state.gameId },
      })
    );
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') {
      return json(200, { ok: true, stale: true });
    }
    throw err;
  }
  return json(200, { ok: true });
}

async function archidektProxy(deckId: string): Promise<LambdaFunctionURLResult> {
  const id = deckId.replace(/[^0-9]/g, '');
  const res = await fetch(`https://archidekt.com/api/decks/${id}/`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  const text = await res.text();
  return {
    statusCode: res.status,
    headers: { 'Content-Type': 'application/json' },
    body: text,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath.replace(/^\/api/, '');
    const parts = path.split('/').filter(Boolean);
    const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};
    const ip = event.requestContext.http.sourceIp ?? '0.0.0.0';

    if (method === 'POST' && parts.length === 1 && parts[0] === 'rooms') {
      return await createRoom(body, ip);
    }

    if (parts[0] === 'rooms' && parts.length === 3) {
      const roomCode = normalizeRoomCode(parts[1]);
      const action = parts[2];
      if (method === 'POST' && action === 'join') return await joinRoom(roomCode, body);

      const claims = bearerClaims(event);
      if (!claims || claims.rc !== roomCode) return json(401, { error: 'Invalid token' });
      if (method === 'GET' && action === 'snapshot') return await getSnapshot(roomCode, claims);
      if (method === 'PUT' && action === 'hidden') return await putHidden(roomCode, claims, body);
    }

    if (method === 'GET' && parts[0] === 'archidekt' && parts[1]) {
      return await archidektProxy(parts[1]);
    }

    return json(404, { error: `No route: ${method} ${path}` });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Internal error' });
  }
}
