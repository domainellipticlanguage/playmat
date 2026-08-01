/**
 * Board persistence model. One item per subject; each state event overwrites
 * its subject's item. This shape is exactly what the AppSync onPublish
 * handler writes to DynamoDB and what local-server keeps in memory, so the
 * snapshot endpoint assembles identically in both worlds.
 */
import type { CardState, PlayerState, PoolCard, RoomState, LogEntry, StateEvent } from './protocol';
import { subjectKey, supersedes } from './protocol';
import type { SeatRecord, SnapshotResponse } from './roomApi';

export interface BoardItem {
  sk: string;
  seq: number;
  by: string;
  g: string;
  t: StateEvent['t'];
  ev: StateEvent;
}

export function boardItemFromEvent(e: StateEvent): BoardItem {
  return { sk: subjectKey(e), seq: e.seq, by: e.by, g: e.g, t: e.t, ev: e };
}

/** Game-scoped subjects vanish on "new game"; the rest survive across games. */
const GAME_SCOPED: StateEvent['t'][] = ['card', 'player', 'log'];

export function assembleSnapshot(
  items: BoardItem[],
  seats: SeatRecord[]
): Omit<SnapshotResponse, 'roomCode' | 'hidden'> {
  // Defensive dedupe (DDB holds one item per sk already, but be safe).
  const bySk = new Map<string, BoardItem>();
  for (const item of items) {
    const cur = bySk.get(item.sk);
    if (!cur || supersedes(item, cur)) bySk.set(item.sk, item);
  }

  const roomItem = bySk.get('room');
  const room: RoomState | null = roomItem && roomItem.ev.t === 'room' ? roomItem.ev.room : null;
  const gameId = room?.gameId ?? null;

  const cards: CardState[] = [];
  const playerStates: PlayerState[] = [];
  const pools: PoolCard[] = [];
  const logs: LogEntry[] = [];
  const seqs: Record<string, { seq: number; by: string }> = {};

  // Only the LATEST import epoch per owner counts; stale chunks from an
  // earlier, larger deck import must not ghost back in. Tokens (no importId)
  // always count.
  const latestImport = new Map<string, string>();
  for (const item of bySk.values()) {
    if (item.ev.t === 'pool' && item.ev.importId) {
      const cur = latestImport.get(item.ev.by);
      if (!cur || item.ev.importId > cur) latestImport.set(item.ev.by, item.ev.importId);
    }
  }

  for (const item of bySk.values()) {
    seqs[item.sk] = { seq: item.seq, by: item.by };
    if (GAME_SCOPED.includes(item.t) && gameId !== null && item.g !== gameId) continue;
    const ev = item.ev;
    switch (ev.t) {
      case 'card':
        if (!ev.card.del) cards.push(ev.card);
        break;
      case 'player':
        playerStates.push(ev.player);
        break;
      case 'pool':
        if (ev.importId && ev.importId !== latestImport.get(ev.by)) break;
        pools.push(...ev.cards);
        break;
      case 'log':
        logs.push(ev.entry);
        break;
    }
  }

  logs.sort((a, b) => a.ts - b.ts);

  return {
    players: seats,
    room,
    cards,
    playerStates,
    pools,
    logs,
    seqs,
    poolImports: Object.fromEntries(latestImport),
  };
}
