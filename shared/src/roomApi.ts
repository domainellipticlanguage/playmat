/**
 * HTTP contracts for the room/session API. Served by the Lambda Function URL
 * in production and by local-server in dev — identical shapes.
 */
import type { CardState, PlayerState, PoolCard, RoomState, LogEntry } from './protocol';

export interface SeatRecord {
  playerId: string;
  seat: number;
  name: string;
  joinedAt: number;
}

export interface CreateRoomRequest {
  name: string;
}
export interface JoinRoomRequest {
  name: string;
  /** For rejoin: previously issued playerId + rejoinKey resume the same seat. */
  playerId?: string;
  rejoinKey?: string;
}
export interface JoinRoomResponse {
  roomCode: string;
  playerId: string;
  /** null = joined as spectator (room full). */
  seat: number | null;
  /** Room-scoped JWT for the events API + snapshot/hidden endpoints. */
  token: string;
  /** Secret proving seat ownership on rejoin. Store in localStorage. */
  rejoinKey: string;
  players: SeatRecord[];
}

export interface HiddenState {
  gameId: string;
  seq: number;
  /** Card guids, index 0 = top of library. */
  library: string[];
  hand: string[];
}

export interface SnapshotResponse {
  roomCode: string;
  players: SeatRecord[];
  room: RoomState | null;
  cards: CardState[];
  playerStates: PlayerState[];
  pools: PoolCard[];
  logs: LogEntry[];
  /** Per-subject seq map so a rejoining client resumes its counters. */
  seqs: Record<string, { seq: number; by: string }>;
  /** Latest deck-import epoch per owner (guards against stale pool chunks). */
  poolImports: Record<string, string>;
  /** Requesting player's own hidden zones (never anyone else's). */
  hidden: HiddenState | null;
}

export interface ApiError {
  error: string;
}

/** Room codes: unambiguous alphabet — no 0/O, 1/I/l (R-1). */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 5;
export const MAX_SEATS = 4;
