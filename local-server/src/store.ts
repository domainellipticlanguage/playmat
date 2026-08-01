/**
 * In-memory equivalent of the Rooms + Board DynamoDB tables. Mirrors exactly
 * what the deployed AppSync onPublish handler and room Lambda do, so game
 * logic developed locally behaves identically in production.
 */
import {
  type BoardItem,
  type HiddenState,
  type SeatRecord,
  type StateEvent,
  boardItemFromEvent,
  supersedes,
  MAX_SEATS,
  newGuid,
  newRoomCode,
} from '@playmat/shared';

export interface SeatRecordInternal extends SeatRecord {
  rejoinKey: string;
}

export interface Room {
  code: string;
  createdAt: number;
  seats: SeatRecordInternal[];
  board: Map<string, BoardItem>;
  hidden: Map<string, HiddenState>;
  /** seq counter for server-published events (seats roster, join logs). */
  serverSeq: number;
}

const rooms = new Map<string, Room>();

export function createRoom(): Room {
  let code = newRoomCode();
  while (rooms.has(code)) code = newRoomCode();
  const room: Room = {
    code,
    createdAt: Date.now(),
    seats: [],
    board: new Map(),
    hidden: new Map(),
    serverSeq: 0,
  };
  rooms.set(code, room);
  return room;
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code);
}

export function listRooms(): Room[] {
  return [...rooms.values()];
}

export type JoinResult =
  | { ok: true; record: SeatRecordInternal; rejoined: boolean; spectator: false }
  | { ok: true; record: { playerId: string; rejoinKey: string }; rejoined: boolean; spectator: true };

export function joinRoom(room: Room, name: string, playerId?: string, rejoinKey?: string): JoinResult {
  if (playerId && rejoinKey) {
    const existing = room.seats.find((s) => s.playerId === playerId && s.rejoinKey === rejoinKey);
    if (existing) {
      existing.name = name || existing.name;
      return { ok: true, record: existing, rejoined: true, spectator: false };
    }
  }
  if (room.seats.length < MAX_SEATS) {
    const taken = new Set(room.seats.map((s) => s.seat));
    let seat = 0;
    while (taken.has(seat)) seat++;
    const record: SeatRecordInternal = {
      playerId: newGuid(),
      seat,
      name,
      joinedAt: Date.now(),
      rejoinKey: newGuid(),
    };
    room.seats.push(record);
    room.seats.sort((a, b) => a.seat - b.seat);
    return { ok: true, record, rejoined: false, spectator: false };
  }
  return { ok: true, record: { playerId: newGuid(), rejoinKey: newGuid() }, rejoined: false, spectator: true };
}

export function publicSeats(room: Room): SeatRecord[] {
  return room.seats.map(({ rejoinKey: _drop, ...rest }) => rest);
}

/**
 * The persistence half of the state-channel onPublish handler: write each
 * event's subject item (last-writer-wins with the same tie-break clients use).
 */
export function persistStateEvent(room: Room, ev: StateEvent): void {
  const item = boardItemFromEvent(ev);
  const cur = room.board.get(item.sk);
  if (!cur || supersedes(item, cur)) room.board.set(item.sk, item);
}
