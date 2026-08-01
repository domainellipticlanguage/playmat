/**
 * Client game state. All mutations flow through applyStateEvent — the same
 * code path for optimistic local actions, live events, and (minus log
 * derivation) snapshot replay — so every client converges.
 */
import { create } from 'zustand';
import {
  type CardState,
  type EphemeralEvent,
  type LogEntry,
  type PlayerState,
  type PoolCard,
  type RoomState,
  type SeatRecord,
  type SnapshotResponse,
  type StateEvent,
  subjectKey,
  supersedes,
} from '@playmat/shared';
import type { StoredSession } from './session';
import type { TransportStatus } from './transport';

export interface Prefs {
  /** Rotate opponents' battlefield cards to face you (readability). */
  faceOpponentCards: boolean;
  /** Ephemeral publish rate for cursor/drag, events per second (E-4). */
  cursorRate: number;
  /** Broadcast my cursor position to the table (P-2). Off by default —
   * drag ghosts still broadcast; idle mousing stays private. */
  shareCursor: boolean;
  /** Show the big hover card preview. */
  hoverPreview: boolean;
  /** Teaching mode: continuously reveal my hand to the table. */
  showHandToTable: boolean;
  defaultLife: number;
}

export interface RemoteCursor {
  x: number;
  y: number;
  ts: number;
  name: string;
}
export interface RemoteDrag {
  x: number;
  y: number;
  by: string;
  ts: number;
  /**
   * Set when the dragger released. The override is NOT removed then — the
   * authoritative card event removes it, so the card never snaps back to its
   * pre-drag position while that event is still in flight. endedAt is only a
   * grace-period fallback for a dropped state event.
   */
  endedAt?: number;
}

interface GameStore {
  session: StoredSession | null;
  connStatus: TransportStatus;
  players: SeatRecord[];
  playerStates: Record<string, PlayerState>;
  room: RoomState | null;
  pool: Record<string, PoolCard>;
  cards: Record<string, CardState>;
  seqs: Record<string, { seq: number; by: string }>;
  /** Own hidden zones. Index 0 = top of library. */
  hidden: { library: string[]; hand: string[] };
  hiddenSeq: number;
  log: LogEntry[];
  cursors: Record<string, RemoteCursor>;
  drags: Record<string, RemoteDrag>;
  presence: Record<string, number>;
  prefs: Prefs;
  selection: string[];
  /** gameId whose per-player setup (shuffle, commanders out) we already ran. */
  setupGameId: string | null;
  /** Latest observed deck-import epoch per owner. */
  poolImports: Record<string, string>;

  setSession(s: StoredSession | null): void;
  setConnStatus(s: TransportStatus): void;
  setPrefs(p: Partial<Prefs>): void;
  setSelection(guids: string[]): void;
  setHidden(library: string[], hand: string[]): void;
  markSetupDone(gameId: string): void;
  applyStateEvent(ev: StateEvent, opts?: { deriveLog?: boolean }): void;
  applyEphemeral(ev: EphemeralEvent): void;
  applySnapshot(snap: SnapshotResponse): void;
  pruneEphemeral(): void;
  appendLog(entry: LogEntry): void;
}

const DEFAULT_PREFS: Prefs = {
  faceOpponentCards: false,
  cursorRate: 8,
  shareCursor: false,
  hoverPreview: true,
  showHandToTable: false,
  defaultLife: 40,
};

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem('playmat') || '{}').prefs ?? {};
    return { ...DEFAULT_PREFS, ...p };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function cardName(pool: Record<string, PoolCard>, guid: string, faceDown: boolean): string {
  if (faceDown) return 'a face-down card';
  const p = pool[guid];
  return p?.sf?.name ?? (p?.custom?.name as string | undefined) ?? 'a card';
}

export const useGame = create<GameStore>((set, get) => ({
  session: null,
  connStatus: 'idle',
  players: [],
  playerStates: {},
  room: null,
  pool: {},
  cards: {},
  seqs: {},
  hidden: { library: [], hand: [] },
  hiddenSeq: 0,
  log: [],
  cursors: {},
  drags: {},
  presence: {},
  prefs: loadPrefs(),
  selection: [],
  setupGameId: null,
  poolImports: {},

  setSession: (session) => set({ session }),
  setConnStatus: (connStatus) => set({ connStatus }),
  setPrefs: (partial) =>
    set((s) => {
      const prefs = { ...s.prefs, ...partial };
      try {
        const stored = JSON.parse(localStorage.getItem('playmat') || '{}');
        stored.prefs = prefs;
        localStorage.setItem('playmat', JSON.stringify(stored));
      } catch {
        // non-fatal
      }
      return { prefs };
    }),
  setSelection: (selection) => set({ selection }),
  setHidden: (library, hand) =>
    set((s) => ({ hidden: { library, hand }, hiddenSeq: s.hiddenSeq + 1 })),
  markSetupDone: (gameId) => set({ setupGameId: gameId }),

  appendLog: (entry) =>
    set((s) => ({ log: [...s.log.slice(-499), entry] })),

  applyStateEvent: (ev, opts = {}) => {
    const state = get();
    const sk = subjectKey(ev);
    const last = state.seqs[sk];
    if (!supersedes(ev, last)) return;
    const deriveLog = opts.deriveLog ?? true;
    const me = state.session?.playerId;

    const patch: Partial<GameStore> = { seqs: { ...state.seqs, [sk]: { seq: ev.seq, by: ev.by } } };

    switch (ev.t) {
      case 'card': {
        const prev = state.cards[ev.card.guid];
        const cards = { ...state.cards };
        if (ev.card.del) delete cards[ev.card.guid];
        else cards[ev.card.guid] = ev.card;
        patch.cards = cards;

        // The authoritative position has landed: retire any drag ghost so the
        // card settles exactly once (no snap-back through the old position).
        if (state.drags[ev.card.guid]) {
          const drags = { ...state.drags };
          delete drags[ev.card.guid];
          patch.drags = drags;
        }

        if (deriveLog) {
          const mover = state.players.find((p) => p.playerId === ev.by)?.name ?? 'Someone';
          const name = cardName(state.pool, ev.card.guid, ev.card.faceDown && !prev);
          if (ev.card.del) {
            patch.log = [...state.log.slice(-499), { kind: 'zone', text: `${mover} removed ${name}`, ts: Date.now() }];
          } else if (!prev && ev.card.zone === 'battlefield') {
            patch.log = [...state.log.slice(-499), { kind: 'zone', text: `${mover} put ${name} onto the battlefield`, ts: Date.now() }];
          } else if (prev && prev.zone !== ev.card.zone) {
            patch.log = [...state.log.slice(-499), { kind: 'zone', text: `${mover} moved ${name} to ${ev.card.zone}`, ts: Date.now() }];
          } else if (!prev?.revealed && ev.card.revealed) {
            patch.log = [...state.log.slice(-499), { kind: 'reveal', text: `${mover} revealed ${cardName(state.pool, ev.card.guid, false)}`, ts: Date.now() }];
          }
        }

        // Z-6 integration: someone put a card into MY hidden zone. Fold it in.
        if (
          me &&
          ev.by !== me &&
          (ev.card.zone === 'library' || ev.card.zone === 'hand') &&
          (ev.card.zoneOwnerId ?? ev.card.ownerId) === me &&
          !state.hidden.library.includes(ev.card.guid) &&
          !state.hidden.hand.includes(ev.card.guid)
        ) {
          const library = state.hidden.library.slice();
          const hand = state.hidden.hand.slice();
          if (ev.card.zone === 'hand') {
            hand.push(ev.card.guid);
          } else {
            const pos = ev.card.libPos ?? 'top';
            if (pos === 'top') library.unshift(ev.card.guid);
            else if (pos === 'bottom') library.push(ev.card.guid);
            else library.splice(Math.min(Math.max(pos, 0), library.length), 0, ev.card.guid);
          }
          patch.hidden = { library, hand };
          patch.hiddenSeq = state.hiddenSeq + 1;
        }
        break;
      }
      case 'player':
        if (deriveLog) {
          const prev = state.playerStates[ev.player.playerId];
          if (prev && prev.life !== ev.player.life) {
            patch.log = [
              ...state.log.slice(-499),
              { kind: 'life', text: `${ev.player.name}: ${prev.life} → ${ev.player.life} life`, ts: Date.now() },
            ];
          }
        }
        patch.playerStates = { ...state.playerStates, [ev.player.playerId]: ev.player };
        break;
      case 'pool': {
        // New import epoch replaces the owner's previous non-token pool;
        // stale chunks from an older import are dropped (see protocol.ts).
        if (ev.importId) {
          const cur = state.poolImports[ev.by];
          if (cur && ev.importId < cur) return;
        }
        const pool = { ...state.pool };
        if (ev.importId && state.poolImports[ev.by] !== ev.importId) {
          for (const [guid, entry] of Object.entries(pool)) {
            if (entry.ownerId === ev.by && !entry.isToken) delete pool[guid];
          }
          patch.poolImports = { ...state.poolImports, [ev.by]: ev.importId };
        }
        for (const c of ev.cards) pool[c.guid] = c;
        patch.pool = pool;
        break;
      }
      case 'room':
        // Game epoch change: the old game's board evaporates (G-7 reset).
        if (state.room && state.room.gameId !== ev.room.gameId) {
          patch.cards = {};
          patch.playerStates = {};
          patch.selection = [];
          patch.drags = {};
        }
        patch.room = ev.room;
        break;
      case 'seats':
        patch.players = ev.seats;
        break;
      case 'log':
        patch.log = [...state.log.slice(-499), ev.entry];
        break;
    }

    set(patch);
  },

  applyEphemeral: (ev) => {
    const state = get();
    const me = state.session?.playerId;
    if ('by' in ev && ev.by === me) return;
    switch (ev.t) {
      case 'cursor': {
        const cur = state.cursors[ev.by];
        if (cur && cur.ts > ev.ts) return;
        const name = state.players.find((p) => p.playerId === ev.by)?.name ?? '?';
        set({
          cursors: { ...state.cursors, [ev.by]: { x: ev.x, y: ev.y, ts: ev.ts, name } },
          presence: { ...state.presence, [ev.by]: Date.now() },
        });
        break;
      }
      case 'drag': {
        const cur = state.drags[ev.guid];
        if (cur && cur.ts > ev.ts) return;
        set({ drags: { ...state.drags, [ev.guid]: { x: ev.x, y: ev.y, by: ev.by, ts: ev.ts } } });
        break;
      }
      case 'dragend': {
        // Keep the ghost at its last position; the card state event clears it.
        const cur = state.drags[ev.guid];
        if (cur) {
          set({ drags: { ...state.drags, [ev.guid]: { ...cur, endedAt: Date.now() } } });
        }
        break;
      }
      case 'presence':
        set({ presence: { ...state.presence, [ev.by]: Date.now() } });
        break;
    }
  },

  applySnapshot: (snap) => {
    const state = get();
    const playerStates: Record<string, PlayerState> = {};
    for (const ps of snap.playerStates) playerStates[ps.playerId] = ps;
    const pool: Record<string, PoolCard> = {};
    for (const c of snap.pools) pool[c.guid] = c;
    const cards: Record<string, CardState> = {};
    for (const c of snap.cards) cards[c.guid] = c;

    // Hidden zones: prefer whichever copy (server vs local) is fresher.
    let hidden = state.hidden;
    let hiddenSeq = state.hiddenSeq;
    if (snap.hidden) {
      const gameId = snap.room?.gameId;
      const serverMatchesGame = !gameId || snap.hidden.gameId === gameId;
      if (serverMatchesGame && snap.hidden.seq >= hiddenSeq) {
        hidden = { library: snap.hidden.library, hand: snap.hidden.hand };
        hiddenSeq = snap.hidden.seq;
      }
    }

    set({
      players: snap.players,
      playerStates,
      room: snap.room,
      pool,
      cards,
      seqs: snap.seqs,
      poolImports: snap.poolImports ?? {},
      log: snap.logs.slice(-500),
      hidden,
      hiddenSeq,
    });
  },

  pruneEphemeral: () => {
    const state = get();
    const now = Date.now();
    const cursors = Object.fromEntries(Object.entries(state.cursors).filter(([, c]) => now - c.ts < 8000));
    const drags = Object.fromEntries(
      Object.entries(state.drags).filter(
        ([, d]) => now - d.ts < 5000 && !(d.endedAt && now - d.endedAt > 1500)
      )
    );
    if (
      Object.keys(cursors).length !== Object.keys(state.cursors).length ||
      Object.keys(drags).length !== Object.keys(state.drags).length
    ) {
      set({ cursors, drags });
    }
  },
}));

/** Next sequence number for a subject, from this client's perspective. */
export function nextSeq(sk: string): number {
  const cur = useGame.getState().seqs[sk];
  return (cur?.seq ?? 0) + 1;
}

// Dev-only escape hatch for debugging in the browser console.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__game = useGame;
}
