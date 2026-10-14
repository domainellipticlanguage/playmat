/**
 * Game verbs. Every action publishes absolute-state events (E-1) with
 * per-subject sequence numbers (E-2) and applies them optimistically (E-7,
 * via sendState). Hidden-zone bookkeeping stays local + counts go public.
 */
import {
  type CardState,
  type LogEntry,
  type PlayerState,
  type PoolCard,
  type RoomState,
  type StateEvent,
  type ZoneName,
  HIDDEN_ZONES,
  newGuid,
  shuffled,
} from '@playmat/shared';
import { sendState as sendToNet, flushHidden, requestHandPeek } from './connection';
import { nextSeq, useGame, cardName } from './store';
import { CARD_H, CARD_W, matRect, matSeatAt, matSlots } from './view';
import { seatDefaultColor } from './colors';

// ---------------------------------------------------------------------------
// Event construction helpers
// ---------------------------------------------------------------------------

function ctx() {
  const s = useGame.getState();
  if (!s.session) throw new Error('No session');
  return {
    s,
    me: s.session.playerId,
    myName: s.session.name,
    gameId: s.room?.gameId ?? '',
  };
}

function cardEvent(card: CardState): StateEvent {
  const { me, gameId } = ctx();
  return { t: 'card', g: gameId, by: me, seq: nextSeq(`card#${card.guid}`), card };
}

function playerEvent(player: PlayerState): StateEvent {
  const { me, gameId } = ctx();
  return { t: 'player', g: gameId, by: me, seq: nextSeq(`player#${player.playerId}`), player };
}

/**
 * Log seqs are timestamp-based but strictly monotonic: two log events from
 * the same publisher in the same millisecond would otherwise share a subject
 * key and the store's supersedes guard would silently drop one (take-turn
 * publishes untap + draw + turn logs in a single burst).
 */
let lastLogSeq = 0;
export function nextLogSeq(): number {
  lastLogSeq = Math.max(lastLogSeq + 1, Date.now() % 1_000_000_000);
  return lastLogSeq;
}

function logEvent(entry: Omit<LogEntry, 'ts'>): StateEvent {
  const { me, gameId } = ctx();
  return { t: 'log', g: gameId, by: me, seq: nextLogSeq(), entry: { ...entry, ts: Date.now() } };
}

function roomEvent(room: RoomState): StateEvent {
  const { me } = ctx();
  return { t: 'room', g: room.gameId, by: me, seq: nextSeq('room'), room };
}

/** My PlayerState with defaults + live hidden-zone counts. */
function myPlayerState(patch: Partial<PlayerState> = {}): PlayerState {
  const { s, me, myName } = ctx();
  const prev = s.playerStates[me];
  const base: PlayerState = prev ?? {
    playerId: me,
    seat: s.session!.seat ?? 0,
    name: myName,
    life: s.prefs.defaultLife,
    counters: {},
    commanderDamage: {},
    handCount: 0,
    libraryCount: 0,
    topRevealed: null,
  };
  const merged = { ...base, ...patch };
  merged.handCount = s.hidden.hand.length;
  merged.libraryCount = s.hidden.library.length;
  // Library order goes out with every publish so peers can browse/search it
  // like any other zone. My hand stays private — only the count ships.
  merged.library = s.hidden.library;
  // Peers need this to know whether my hand is open for them to act on. It's
  // per-room state (a peer may open it — Duress, Gitaxian Probe); my teaching-
  // mode pref only seeds it the first time I publish in a room.
  merged.showHandToTable = patch.showHandToTable ?? prev?.showHandToTable ?? s.prefs.showHandToTable;
  // Identity color + playmat ride along on every publish; the color always
  // resolves (seat default) so peers never have to guess.
  merged.color = s.prefs.playerColor ?? merged.color ?? seatDefaultColor(merged.seat).name;
  merged.playmat = s.prefs.playmatStyle ?? merged.playmat;
  merged.sleeve = s.prefs.sleeveStyle ?? merged.sleeve;
  if (merged.topRevealed !== null) merged.topRevealed = s.hidden.library[0] ?? null;
  return merged;
}

/** Any player's state (honor system: you may adjust an opponent's life). */
function theirPlayerState(playerId: string, patch: Partial<PlayerState>): PlayerState {
  const { s } = ctx();
  const seat = s.players.find((p) => p.playerId === playerId);
  const prev = s.playerStates[playerId] ?? {
    playerId,
    seat: seat?.seat ?? 0,
    name: seat?.name ?? '?',
    life: s.prefs.defaultLife,
    counters: {},
    commanderDamage: {},
    handCount: 0,
    libraryCount: 0,
    topRevealed: null,
  };
  return { ...prev, ...patch };
}

function defaultCardState(guid: string): CardState {
  const { s, me } = ctx();
  const pool = s.pool[guid];
  return {
    guid,
    zone: 'library',
    ownerId: pool?.ownerId ?? me,
    controllerId: pool?.ownerId ?? me,
    x: 0,
    y: 0,
    z: 0,
    tapped: false,
    faceDown: false,
    faceIndex: 0,
    rotIndex: 0,
    counters: {},
    order: 0,
  };
}

function currentCard(guid: string): CardState {
  const { s } = ctx();
  return s.cards[guid] ?? defaultCardState(guid);
}

function topOrder(zone: ZoneName, zoneOwnerId: string): number {
  const { s } = ctx();
  let max = 0;
  for (const c of Object.values(s.cards)) {
    if (c.zone === zone && (c.zoneOwnerId ?? c.ownerId) === zoneOwnerId) max = Math.max(max, c.order);
  }
  return max + 1;
}

/** Highest battlefield stacking value; a dropped card lands at topZ()+1. */
function topZ(): number {
  const { s } = ctx();
  let max = 0;
  for (const c of Object.values(s.cards)) {
    if (c.zone === 'battlefield') max = Math.max(max, c.z ?? 0);
  }
  return max;
}

// ---------------------------------------------------------------------------
// Hidden-zone plumbing
// ---------------------------------------------------------------------------

function removeFromHidden(guid: string): 'library' | 'hand' | null {
  const { s } = ctx();
  const lib = s.hidden.library.indexOf(guid);
  if (lib >= 0) {
    const library = s.hidden.library.slice();
    library.splice(lib, 1);
    s.setHidden(library, s.hidden.hand);
    return 'library';
  }
  const hand = s.hidden.hand.indexOf(guid);
  if (hand >= 0) {
    const handArr = s.hidden.hand.slice();
    handArr.splice(hand, 1);
    s.setHidden(s.hidden.library, handArr);
    return 'hand';
  }
  return null;
}

function addToHidden(
  guid: string,
  zone: 'library' | 'hand',
  libPos: 'top' | 'bottom' | number = 'top',
  handIndex?: number
): void {
  const { s } = ctx();
  if (zone === 'hand') {
    const hand = s.hidden.hand.slice();
    hand.splice(Math.min(Math.max(handIndex ?? hand.length, 0), hand.length), 0, guid);
    s.setHidden(s.hidden.library, hand);
    return;
  }
  const library = s.hidden.library.slice();
  if (libPos === 'top') library.unshift(guid);
  else if (libPos === 'bottom') library.push(guid);
  else library.splice(Math.min(Math.max(libPos, 0), library.length), 0, guid);
  s.setHidden(library, s.hidden.hand);
}

/** Is my hand open to the table in this room (teaching mode, or a peer opened it)? */
export function handOpen(): boolean {
  const { s, me } = ctx();
  return s.playerStates[me]?.showHandToTable ?? s.prefs.showHandToTable;
}

/** Reveal-sync for teaching mode: keep every hand card published as revealed. */
function syncHandReveals(events: StateEvent[]): void {
  const { s, me } = ctx();
  if (!handOpen()) return;
  for (const guid of s.hidden.hand) {
    const cur = s.cards[guid];
    if (!cur || cur.zone !== 'hand' || !cur.revealed) {
      events.push(cardEvent({ ...currentCard(guid), zone: 'hand', zoneOwnerId: me, revealed: true }));
    }
  }
}

// ---------------------------------------------------------------------------
// Undo: a local stack of pre-action snapshots. Events are absolute per-subject
// states (LWW), so undo = republish each touched subject's PRIOR state with a
// fresh seq — no inverse verbs, no wire changes. Hidden zones ride along as
// O(1) array refs (setHidden always replaces, never mutates). The one
// non-generic case: a card that left a PEER's library has no prior public
// marker, so its restore is a zone:'library' event their Z-6 fold-in honors.
// ---------------------------------------------------------------------------

type UndoPrior =
  | { t: 'card'; state: CardState }
  | { t: 'card-absent'; guid: string }
  | { t: 'card-library'; guid: string; ownerId: string; index: number }
  | { t: 'player'; state: PlayerState }
  | { t: 'room'; state: RoomState }
  /** First touch had no prior worth restoring; blocks later mid-batch capture. */
  | { t: 'skip' };

interface UndoEntry {
  label: string;
  gameId: string;
  hidden: { library: string[]; hand: string[] };
  priors: Map<string, UndoPrior>;
}

const UNDO_CAP = 50;
const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];
let batch: UndoEntry | null = null;

/** Group everything `fn` publishes into ONE undo entry (nesting: outermost wins). */
export function withUndo(label: string, fn: () => void): void {
  if (batch) return fn();
  const s = useGame.getState();
  if (!s.session) return fn();
  batch = {
    label,
    gameId: s.room?.gameId ?? '',
    hidden: { library: s.hidden.library, hand: s.hidden.hand },
    priors: new Map(),
  };
  try {
    fn();
  } finally {
    const b = batch!;
    batch = null;
    const st = useGame.getState();
    const hiddenChanged =
      b.hidden.library !== st.hidden.library || b.hidden.hand !== st.hidden.hand;
    if (hiddenChanged || [...b.priors.values()].some((p) => p.t !== 'skip')) {
      undoStack.push(b);
      if (undoStack.length > UNDO_CAP) undoStack.shift();
      redoStack.length = 0; // a fresh action forks history
    }
  }
}

/** Wrap an action so each top-level call becomes one undo entry. */
function undoable<A extends unknown[]>(
  label: string | ((...args: A) => string),
  fn: (...args: A) => void
): (...args: A) => void {
  return (...args: A) =>
    withUndo(typeof label === 'function' ? label(...args) : label, () => fn(...args));
}

/** Snapshot the pre-publish state of every subject in `events` (first touch wins). */
function captureUndo(events: StateEvent[]): void {
  const b = batch;
  if (!b) return;
  const s = useGame.getState();
  for (const ev of events) {
    if (ev.t === 'card') {
      const key = `card#${ev.card.guid}`;
      if (b.priors.has(key)) continue;
      // A card with no public marker sitting in a PEER's published library
      // (mill/tuck) must restore as put-it-back, not deletion — cardPriorNow
      // handles all three shapes.
      b.priors.set(key, cardPriorNow(ev.card.guid, ev.card.ownerId));
    } else if (ev.t === 'player') {
      const key = `player#${ev.player.playerId}`;
      if (b.priors.has(key)) continue;
      const prev = s.playerStates[ev.player.playerId];
      b.priors.set(key, prev ? { t: 'player', state: prev } : { t: 'skip' });
    } else if (ev.t === 'room') {
      if (!b.priors.has('room')) b.priors.set('room', s.room ? { t: 'room', state: s.room } : { t: 'skip' });
    }
  }
}

/** All action publishes flow through here: capture undo priors, then send. */
function sendState(events: StateEvent[]): void {
  captureUndo(events);
  sendToNet(events);
}

export function clearUndo(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

/** The current best restore target for one card guid (shared undo/redo capture). */
function cardPriorNow(guid: string, ownerHint?: string): UndoPrior {
  const s = useGame.getState();
  const prev = s.cards[guid];
  if (prev) return { t: 'card', state: prev };
  const me = s.session?.playerId;
  const owner = s.pool[guid]?.ownerId ?? ownerHint ?? me ?? '';
  const index = owner !== me ? (s.playerStates[owner]?.library?.indexOf(guid) ?? -1) : -1;
  return index >= 0 ? { t: 'card-library', guid, ownerId: owner, index } : { t: 'card-absent', guid };
}

/** Current state of an entry's subjects — the inverse entry for the opposite stack. */
function inverseOf(entry: UndoEntry): UndoEntry {
  const s = useGame.getState();
  const priors = new Map<string, UndoPrior>();
  for (const key of entry.priors.keys()) {
    if (key === 'room') {
      priors.set(key, s.room ? { t: 'room', state: s.room } : { t: 'skip' });
    } else if (key.startsWith('card#')) {
      priors.set(key, cardPriorNow(key.slice('card#'.length)));
    } else if (key.startsWith('player#')) {
      const prev = s.playerStates[key.slice('player#'.length)];
      priors.set(key, prev ? { t: 'player', state: prev } : { t: 'skip' });
    }
  }
  return {
    label: entry.label,
    gameId: entry.gameId,
    hidden: { library: s.hidden.library, hand: s.hidden.hand },
    priors,
  };
}

/** Top entry of a stack for the CURRENT game (older-game leftovers are dropped). */
function peekValid(stack: UndoEntry[]): UndoEntry | null {
  const gid = useGame.getState().room?.gameId ?? '';
  while (stack.length && stack[stack.length - 1].gameId !== gid) stack.pop();
  return stack[stack.length - 1] ?? null;
}

export function canUndo(): boolean {
  return peekValid(undoStack) !== null;
}

export function undoLabel(): string | null {
  return peekValid(undoStack)?.label ?? null;
}

export function canRedo(): boolean {
  return peekValid(redoStack) !== null;
}

export function redoLabel(): string | null {
  return peekValid(redoStack)?.label ?? null;
}

/** Republish an entry's snapshots — the shared engine of undo AND redo. */
function applyEntry(entry: UndoEntry, verb: 'undid' | 'redid'): void {
  const { s, me, myName } = ctx();
  // Hidden zones first: my player-state republish derives counts from them.
  const hiddenChanged =
    entry.hidden.library !== s.hidden.library || entry.hidden.hand !== s.hidden.hand;
  if (hiddenChanged) s.setHidden(entry.hidden.library, entry.hidden.hand);
  const events: StateEvent[] = [];
  let myPlayerDone = false;
  for (const prior of entry.priors.values()) {
    switch (prior.t) {
      case 'card':
        events.push(cardEvent(prior.state));
        break;
      case 'card-absent':
        if (useGame.getState().cards[prior.guid]) {
          events.push(cardEvent({ ...currentCard(prior.guid), del: true }));
        }
        break;
      case 'card-library':
        events.push(
          cardEvent({
            ...currentCard(prior.guid),
            zone: 'library',
            zoneOwnerId: prior.ownerId,
            controllerId: prior.ownerId,
            tapped: false,
            faceDown: false,
            rotIndex: 0,
            counters: {},
            revealed: false,
            order: 0,
            libPos: prior.index,
          })
        );
        break;
      case 'player':
        if (prior.state.playerId === me) {
          events.push(playerEvent(myPlayerState(prior.state)));
          myPlayerDone = true;
        } else {
          events.push(playerEvent(theirPlayerState(prior.state.playerId, prior.state)));
        }
        break;
      case 'room':
        events.push(roomEvent(prior.state));
        break;
      case 'skip':
        break;
    }
  }
  if (hiddenChanged && !myPlayerDone) events.push(playerEvent(myPlayerState()));
  events.push(logEvent({ kind: 'note', text: `${myName} ${verb}: ${entry.label}` }));
  sendState(events); // no batch open → captures nothing (undo isn't undoable)
}

export function undoLast(): void {
  const entry = peekValid(undoStack);
  if (!entry) return;
  undoStack.pop();
  redoStack.push(inverseOf(entry));
  applyEntry(entry, 'undid');
}

export function redoLast(): void {
  const entry = peekValid(redoStack);
  if (!entry) return;
  redoStack.pop();
  undoStack.push(inverseOf(entry));
  applyEntry(entry, 'redid');
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

export const drawCards = undoable('draw', (n: number): void => {
  const { s, me, myName } = ctx();
  const take = s.hidden.library.slice(0, n);
  if (take.length === 0) return;
  s.setHidden(s.hidden.library.slice(take.length), [...s.hidden.hand, ...take]);
  const events: StateEvent[] = [];
  // A drawn card that had a public marker (e.g. tucked from battlefield) needs
  // its marker moved to hand so peers keep it hidden but tracked.
  for (const guid of take) {
    if (s.cards[guid]) events.push(cardEvent({ ...currentCard(guid), zone: 'hand', zoneOwnerId: me, revealed: false }));
  }
  syncHandReveals(events);
  events.push(playerEvent(myPlayerState()));
  events.push(logEvent({ kind: 'note', text: `${myName} drew ${take.length} card${take.length > 1 ? 's' : ''}` }));
  sendState(events);
});

export interface MoveTarget {
  zone: ZoneName;
  x?: number;
  y?: number;
  libPos?: 'top' | 'bottom' | number;
  /** Insertion slot when the zone is my hand (default: rightmost). */
  handIndex?: number;
  faceDown?: boolean;
}

/** Whoever physically owns this card, per the pool (falling back to its state). */
export function ownerOf(guid: string): string {
  const { s, me } = ctx();
  return s.pool[guid]?.ownerId ?? s.cards[guid]?.ownerId ?? me;
}

/**
 * May this card be placed into `zone` belonging to `zoneOwnerId`?
 *
 * A card only ever occupies its OWNER's graveyard/library/hand/exile/command —
 * milling an opponent puts cards in THEIR graveyard, and nothing of yours can
 * end up in their deck. The battlefield is the exception: controllerId lets you
 * steal a permanent and it sits on your side of the table.
 */
export function canPlaceIn(guid: string, zone: ZoneName, zoneOwnerId?: string): boolean {
  if (zone === 'battlefield' || !zoneOwnerId) return true;
  return ownerOf(guid) === zoneOwnerId;
}

/** True when the card's front face is a land. */
function isLand(pool: PoolCard | undefined): boolean {
  return /\bLand\b/.test(pool?.sf?.faces[0]?.type ?? '');
}

/** The seat numbers currently occupied (mats exist only for these). */
function occupiedSeats(): number[] {
  const { s } = ctx();
  return s.players.map((p) => p.seat);
}

/**
 * Archidekt-style placement for "Play" without an explicit drop point: lands
 * slot into the row hugging their owner's edge of their PLAYMAT, everything
 * else into the row toward the table center. A slot counts as occupied when
 * any battlefield card sits near it, so manually dragging a card away frees
 * its slot — no synced state.
 */
export function autoPlayPosition(guid: string): { x: number; y: number } {
  const { s } = ctx();
  const owner = ownerOf(guid);
  const seats = occupiedSeats();
  const seat = s.players.find((p) => p.playerId === owner)?.seat ?? s.session?.seat ?? 0;
  const row = isLand(s.pool[guid]) ? 0 : 1;
  const taken = (x: number, y: number) =>
    Object.values(s.cards).some(
      (c) =>
        c.zone === 'battlefield' &&
        Math.abs(c.x - x) < CARD_W * 0.55 &&
        Math.abs(c.y - y) < CARD_H * 0.55
    );
  const slots = matSlots(seat, matRect(seat, (q) => seats.includes(q)), row);
  for (const p of slots) {
    if (!taken(p.x, p.y)) return p;
  }
  // Row full: start a new LAYER across the same slots — every slot gets its
  // second card (staggered so the buried card keeps a readable corner)
  // before any slot gets a third, instead of one slot growing a runaway
  // pile. Needs its own tight occupancy check: the stagger step is
  // deliberately smaller than a card, so `taken`'s card-sized tolerance
  // would call every layered spot occupied.
  const near = (x: number, y: number) =>
    Object.values(s.cards).some(
      (c) => c.zone === 'battlefield' && Math.abs(c.x - x) < 20 && Math.abs(c.y - y) < 20
    );
  for (let layer = 1; layer < 15; layer++) {
    for (const p of slots) {
      const cand = { x: p.x + 32 * layer, y: p.y + 24 * layer };
      if (!near(cand.x, cand.y)) return cand;
    }
  }
  const last = slots[slots.length - 1];
  return { x: last.x + 32, y: last.y + 24 };
}

/**
 * Battlefield control follows the playmats: a card sitting on a player's mat
 * is controlled by that player (dragging someone's card onto your mat claims
 * it — and rotates it to your orientation, since cards render in their
 * controller's orientation). The DMZ and off-mat space keep the current
 * controller.
 */
function controllerAt(x: number, y: number, current: string): string {
  const { s } = ctx();
  const seat = matSeatAt(x, y, occupiedSeats());
  if (seat === null) return current;
  return s.players.find((p) => p.seat === seat)?.playerId ?? current;
}

/** A control-change log entry, or null when nothing changed. */
function controlLog(guid: string, prev: CardState, nextController: string): StateEvent | null {
  const { s } = ctx();
  if (prev.zone !== 'battlefield' || prev.controllerId === nextController) return null;
  const name = s.players.find((p) => p.playerId === nextController)?.name ?? '?';
  return logEvent({ kind: 'zone', text: `${name} now controls ${cardName(s.pool, guid, prev.faceDown)}` });
}

/**
 * Re-publish a card's current state unchanged (just a seq bump). A drag that
 * ends without a move — e.g. a drop refused by canPlaceIn — publishes no card
 * event, so peers' drag ghosts would hover out the full 1.5s dragend grace
 * before snapping back. A card event retires the ghost immediately.
 */
export function reassertCards(guids: string[]): void {
  const { s } = ctx();
  sendState(guids.filter((g) => s.cards[g]).map((g) => cardEvent(currentCard(g))));
}

/** The universal move (C-11, Z-6). Handles hidden<->public bookkeeping. */
export const moveCard = undoable('move card', (guid: string, target: MoveTarget): void => {
  const { s, me } = ctx();
  const cur = currentCard(guid);
  // Not caller-supplied: the destination zone's owner IS the card's owner for
  // every non-battlefield zone, so a mis-aimed drop can't relocate a card into
  // someone else's deck. Callers should gate on canPlaceIn() to avoid a
  // surprise teleport home; this is the backstop that makes it impossible.
  const zoneOwnerId = ownerOf(guid);
  const wasPublic = !!s.cards[guid] && !HIDDEN_ZONES.includes(s.cards[guid].zone);

  // Tokens are battlefield-only (Archidekt behavior): moved anywhere else,
  // they cease to exist instead of changing zone.
  if (cur.zone === 'battlefield' && target.zone !== 'battlefield' && s.pool[guid]?.isToken) {
    sendState([
      cardEvent({ ...cur, del: true }),
      logEvent({ kind: 'zone', text: `${cardName(s.pool, guid, cur.faceDown)} ceased to exist (token)` }),
    ]);
    return;
  }

  const fromHidden = removeFromHidden(guid);

  const leavingBattlefield = cur.zone === 'battlefield' && target.zone !== 'battlefield';
  const targetX = target.x ?? cur.x;
  const targetY = target.y ?? cur.y;
  // On the battlefield the mat under the card decides control; everywhere
  // else control reverts to the owner.
  const controllerId =
    target.zone === 'battlefield' ? controllerAt(targetX, targetY, cur.controllerId) : zoneOwnerId;
  const next: CardState = {
    ...cur,
    zone: target.zone,
    zoneOwnerId: zoneOwnerId === cur.ownerId ? undefined : zoneOwnerId,
    controllerId,
    x: targetX,
    y: targetY,
    // Anything placed on the battlefield lands on top of the stack.
    z: target.zone === 'battlefield' ? topZ() + 1 : 0,
    tapped: leavingBattlefield ? false : cur.tapped,
    faceDown: target.faceDown ?? (leavingBattlefield ? false : cur.faceDown),
    rotIndex: leavingBattlefield ? 0 : cur.rotIndex,
    // Counters fall off a permanent that leaves — except commander tax, which
    // belongs to the commander across every trip back to the command zone.
    counters: leavingBattlefield ? (cur.counters.tax ? { tax: cur.counters.tax } : {}) : cur.counters,
    manifest: leavingBattlefield || target.faceDown === false ? undefined : cur.manifest,
    revealed: false,
    order: ['graveyard', 'exile', 'command'].includes(target.zone) ? topOrder(target.zone, zoneOwnerId) : 0,
    libPos: target.zone === 'library' ? target.libPos ?? 'top' : undefined,
  };

  const events: StateEvent[] = [];
  const targetIsMyHidden = HIDDEN_ZONES.includes(target.zone) && zoneOwnerId === me;

  if (targetIsMyHidden) {
    addToHidden(guid, target.zone as 'library' | 'hand', target.libPos ?? 'top', target.handIndex);
    // Only publish a removal marker if peers currently see this card.
    if (wasPublic || s.cards[guid]) events.push(cardEvent(next));
  } else {
    events.push(cardEvent(next));
  }
  const ctlLog = controlLog(guid, cur, next.controllerId);
  if (ctlLog) events.push(ctlLog);

  if (fromHidden || targetIsMyHidden) {
    syncHandReveals(events);
    events.push(playerEvent(myPlayerState()));
  }
  sendState(events);
});

export const playFromHand = undoable(
  'play card',
  (guid: string, x: number, y: number, faceDown: boolean = false): void => {
    moveCard(guid, { zone: 'battlefield', x, y, faceDown });
  }
);

/** Mill: top N of my library into my graveyard, with one log line. */
export const millCards = undoable('mill', (n: number): void => {
  const { s, myName } = ctx();
  const take = s.hidden.library.slice(0, n);
  for (const guid of take) moveCard(guid, { zone: 'graveyard' });
  if (take.length) {
    sendState([
      logEvent({ kind: 'zone', text: `${myName} milled ${take.length} card${take.length > 1 ? 's' : ''}` }),
    ]);
  }
});

/**
 * Mill a PEER from their published library order (honor system, like life).
 * The store prunes milled guids from that copy as the card events apply, so
 * repeated mills see fresh tops without waiting for the owner's republish.
 */
export const millTheirCards = undoable('mill', (ownerId: string, n: number): void => {
  const { s, myName } = ctx();
  const name = s.players.find((p) => p.playerId === ownerId)?.name ?? '?';
  const take = (s.playerStates[ownerId]?.library ?? []).slice(0, n);
  for (const guid of take) moveCard(guid, { zone: 'graveyard' });
  if (take.length) {
    sendState([
      logEvent({
        kind: 'zone',
        text: `${myName} milled ${take.length} of ${name}'s card${take.length > 1 ? 's' : ''}`,
      }),
    ]);
  }
});

/** Reorder my hand locally — order is private, so nothing is published. */
export function reorderHand(guid: string, toIndex: number): void {
  const { s } = ctx();
  if (!s.hidden.hand.includes(guid)) return;
  const hand = s.hidden.hand.filter((g) => g !== guid);
  hand.splice(Math.min(Math.max(toIndex, 0), hand.length), 0, guid);
  s.setHidden(s.hidden.library, hand);
}

export const setCardPosition = undoable('move card', (guid: string, x: number, y: number): void => {
  const cur = currentCard(guid);
  const controllerId = cur.zone === 'battlefield' ? controllerAt(x, y, cur.controllerId) : cur.controllerId;
  const z = cur.zone === 'battlefield' ? topZ() + 1 : cur.z;
  const events: StateEvent[] = [cardEvent({ ...cur, x, y, z, controllerId })];
  const log = controlLog(guid, cur, controllerId);
  if (log) events.push(log);
  sendState(events);
});

export const moveCardsGroup = undoable('move cards', (moves: { guid: string; x: number; y: number }[]): void => {
  const events: StateEvent[] = [];
  // The whole group rises above everything else, keeping its own internal
  // stacking (sort by current z, then reassign contiguously above topZ).
  const base = topZ();
  const ordered = [...moves].sort((a, b) => (currentCard(a.guid).z ?? 0) - (currentCard(b.guid).z ?? 0));
  ordered.forEach(({ guid, x, y }, i) => {
    const cur = currentCard(guid);
    const controllerId = cur.zone === 'battlefield' ? controllerAt(x, y, cur.controllerId) : cur.controllerId;
    const z = cur.zone === 'battlefield' ? base + 1 + i : cur.z;
    events.push(cardEvent({ ...cur, x, y, z, controllerId }));
    const log = controlLog(guid, cur, controllerId);
    if (log) events.push(log);
  });
  sendState(events);
});

export const tapCards = undoable(
  (_guids: string[], tapped: boolean) => (tapped ? 'tap' : 'untap'),
  (guids: string[], tapped: boolean): void => {
    const events = guids
      .map((g) => currentCard(g))
      .filter((c) => c.tapped !== tapped)
      .map((c) => cardEvent({ ...c, tapped }));
    if (events.length) sendState(events);
  }
);

export const untapAll = undoable('untap all', (): void => {
  const { s, me, myName } = ctx();
  const mine = Object.values(s.cards).filter(
    (c) => c.zone === 'battlefield' && c.controllerId === me && c.tapped
  );
  if (!mine.length) return;
  sendState([...mine.map((c) => cardEvent({ ...c, tapped: false })), logEvent({ kind: 'note', text: `${myName} untapped` })]);
});

/**
 * Proliferate (Archidekt's "Proliferate all counters", honor system): every
 * battlefield card and every player with at least one counter gets one more
 * of each kind it already has. Rules-wise proliferate is "any number you
 * choose" — the common case is everything, and stragglers are hand-fixed.
 */
export const proliferate = undoable('proliferate', (): void => {
  const { s, me, myName } = ctx();
  const events: StateEvent[] = [];
  for (const c of Object.values(s.cards)) {
    if (c.zone !== 'battlefield' || Object.keys(c.counters).length === 0) continue;
    const counters = { ...c.counters };
    for (const k of Object.keys(counters)) counters[k] += 1;
    events.push(cardEvent({ ...c, counters }));
  }
  for (const p of Object.values(s.playerStates)) {
    if (Object.keys(p.counters ?? {}).length === 0) continue;
    const counters = { ...p.counters };
    for (const k of Object.keys(counters)) counters[k] += 1;
    events.push(
      playerEvent(p.playerId === me ? myPlayerState({ counters }) : theirPlayerState(p.playerId, { counters }))
    );
  }
  if (!events.length) return;
  events.push(logEvent({ kind: 'note', text: `${myName} proliferated` }));
  sendState(events);
});

export const setRotIndex = undoable('turn/transform', (guid: string, rotIndex: number): void => {
  sendState([cardEvent({ ...currentCard(guid), rotIndex })]);
});

export const setFaceDown = undoable('flip', (guid: string, faceDown: boolean): void => {
  sendState([cardEvent({ ...currentCard(guid), faceDown, manifest: faceDown ? currentCard(guid).manifest : undefined })]);
});

/** Mark a face-down card as a 2/2 creature (manifest, morph, disguise…). */
export const setManifest = undoable('manifest', (guid: string, manifest: boolean): void => {
  sendState([cardEvent({ ...currentCard(guid), manifest: manifest || undefined })]);
});

export const setCounter = undoable('counter change', (guid: string, label: string, value: number): void => {
  const cur = currentCard(guid);
  const counters = { ...cur.counters };
  if (value <= 0) delete counters[label];
  else counters[label] = value;
  sendState([cardEvent({ ...cur, counters })]);
});

export const revealFromHand = undoable('reveal', (guid: string, revealed: boolean): void => {
  const { me } = ctx();
  sendState([cardEvent({ ...currentCard(guid), zone: 'hand', zoneOwnerId: me, revealed })]);
});

/** The teaching-mode pref: my default for new rooms, and this room right now. */
export function setShowHandToTable(on: boolean): void {
  ctx().s.setPrefs({ showHandToTable: on });
  openMyHand(on);
}

/** Card events that publish every card in my hand as revealed / hidden. */
function handRevealEvents(on: boolean): StateEvent[] {
  const { s, me } = ctx();
  return s.hidden.hand
    .filter((guid) => !!s.cards[guid]?.revealed !== on || s.cards[guid]?.zone !== 'hand')
    .map((guid) => cardEvent({ ...currentCard(guid), zone: 'hand', zoneOwnerId: me, revealed: on }));
}

function openMyHand(on: boolean): void {
  // Publish the flag itself, not just the reveals — peers gate whether they may
  // act on my hand on this, and an empty hand would otherwise announce nothing.
  sendState([...handRevealEvents(on), playerEvent(myPlayerState({ showHandToTable: on }))]);
}

/**
 * Open (or close) a player's hand to the table for the rest of the game —
 * anyone may, for anyone (Duress, Gitaxian Probe…; honor system). For a peer
 * this only flips their published flag: their client owns the hand's contents
 * and answers with the reveals (`syncOpenHand`, wired in connection.ts).
 */
export const setHandOpen = undoable('reveal hand', (playerId: string, on: boolean): void => {
  const { s, me, myName } = ctx();
  if (playerId === me) {
    openMyHand(on);
    return;
  }
  const name = s.players.find((p) => p.playerId === playerId)?.name ?? '?';
  sendState([
    playerEvent(theirPlayerState(playerId, { showHandToTable: on })),
    logEvent({ kind: 'reveal', text: on ? `${myName} revealed ${name}'s hand` : `${myName} stopped revealing ${name}'s hand` }),
  ]);
});

/**
 * Look at a player's hand privately (Gitaxian Probe). The table log says you
 * looked; only you see the cards — their client answers the request.
 */
export function peekHand(playerId: string): void {
  const { s, myName } = ctx();
  const name = s.players.find((p) => p.playerId === playerId)?.name ?? '?';
  sendState([logEvent({ kind: 'reveal', text: `${myName} looked at ${name}'s hand` })]);
  requestHandPeek(playerId);
}

/**
 * My side of a peer opening/closing my hand, and of cards arriving in an open
 * hand: publish the reveals so they match the flag. Idempotent — only cards
 * whose published state disagrees get an event.
 */
export function syncOpenHand(on: boolean): void {
  const events = handRevealEvents(on);
  if (events.length) sendState(events);
}

// --- Library operations -----------------------------------------------------

export const shuffleLibrary = undoable('shuffle', (quiet = false): void => {
  const { s, myName } = ctx();
  s.setHidden(shuffled(s.hidden.library), s.hidden.hand);
  const events: StateEvent[] = [playerEvent(myPlayerState())];
  if (!quiet) events.push(logEvent({ kind: 'shuffle', text: `${myName} shuffled their library` }));
  sendState(events);
});

/** Commit a peek/scry/surveil: reorder the peeked window in place. */
export const commitPeek = undoable(
  'peek/scry',
  (opts: { seen: number; keepTop: string[]; toBottom: string[]; label?: string }): void => {
    const { s, myName } = ctx();
    const rest = s.hidden.library.slice(opts.seen);
    s.setHidden([...opts.keepTop, ...rest, ...opts.toBottom], s.hidden.hand);
    sendState([
      playerEvent(myPlayerState()),
      logEvent({ kind: 'note', text: `${myName} ${opts.label ?? `looked at the top ${opts.seen}`}` }),
    ]);
  }
);

export const setTopRevealed = undoable('top reveal', (on: boolean): void => {
  const { s } = ctx();
  sendState([playerEvent(myPlayerState({ topRevealed: on ? s.hidden.library[0] ?? null : null }))]);
});

// --- Player state -----------------------------------------------------------

/**
 * Republish my hidden-zone counts. Needed when my hand or library changed
 * without one of my own actions driving it — e.g. another player discarded a
 * card from my hand in teaching mode. connection.ts calls this when it notices
 * the published counts have drifted from the real ones.
 */
export function publishMyCounts(): void {
  sendState([playerEvent(myPlayerState())]);
}

export const setLife = undoable('life change', (playerId: string, life: number): void => {
  const { me } = ctx();
  const ps = playerId === me ? myPlayerState({ life }) : theirPlayerState(playerId, { life });
  sendState([playerEvent(ps)]);
});

export const setPlayerCounter = undoable('player counter', (playerId: string, name: string, value: number): void => {
  const { s, me } = ctx();
  const prev = s.playerStates[playerId]?.counters ?? {};
  const counters = { ...prev };
  if (value <= 0) delete counters[name];
  else counters[name] = value;
  const ps = playerId === me ? myPlayerState({ counters }) : theirPlayerState(playerId, { counters });
  sendState([playerEvent(ps)]);
});

/** Commander damage ticks the victim's life in the same event (README §2.1). */
export const dealCommanderDamage = undoable('commander damage', (victimId: string, commanderGuid: string, delta: number): void => {
  const { s, me } = ctx();
  const prev = s.playerStates[victimId];
  const prevDmg = prev?.commanderDamage?.[commanderGuid] ?? 0;
  const nextDmg = Math.max(0, prevDmg + delta);
  const applied = nextDmg - prevDmg;
  const commanderDamage = { ...(prev?.commanderDamage ?? {}), [commanderGuid]: nextDmg };
  if (nextDmg === 0) delete commanderDamage[commanderGuid];
  const life = (prev?.life ?? s.prefs.defaultLife) - applied;
  const ps =
    victimId === me
      ? myPlayerState({ commanderDamage, life })
      : theirPlayerState(victimId, { commanderDamage, life });
  sendState([playerEvent(ps)]);
});

// --- Tokens (C-7) -----------------------------------------------------------

function nextPoolChunk(): number {
  const { s, me } = ctx();
  let max = 999; // token chunks start above any import chunk
  for (const sk of Object.keys(s.seqs)) {
    const m = sk.match(new RegExp(`^pool#${me}#(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export const createTokens = undoable('create tokens', (tokens: PoolCard[], at: { x: number; y: number }): void => {
  const { s, me, gameId, myName } = ctx();
  const events: StateEvent[] = [
    { t: 'pool', g: gameId, by: me, seq: 1, chunk: nextPoolChunk(), nChunks: 1, cards: tokens },
  ];
  const base = topZ();
  tokens.forEach((tok, i) => {
    const x = at.x + i * 30;
    const y = at.y + i * 12;
    events.push(
      cardEvent({
        ...defaultCardState(tok.guid),
        ownerId: me,
        // A token spawned onto someone's mat is theirs to control.
        controllerId: controllerAt(x, y, me),
        zone: 'battlefield',
        x,
        y,
        z: base + 1 + i,
      })
    );
  });
  events.push(logEvent({ kind: 'note', text: `${myName} created ${tokens.length} token${tokens.length > 1 ? 's' : ''}` }));
  // Tokens need their pool entry to land with/before their card state; the
  // store applies optimistically in order and peers tolerate either order.
  sendState(events);
});

const TOKEN_FRAME: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

/**
 * Crucible CardData for a token copy of a real card: same name/type/text/P-T
 * and the card's art crop, but drawn as a token face — so a copy is visibly
 * a token, not a pixel-identical duplicate.
 */
function tokenDataFrom(src: PoolCard): Record<string, unknown> {
  if (src.custom) return { ...src.custom };
  const face = src.sf?.faces[0];
  // "Token" leads the type line, ahead of supertypes — strip any existing
  // placement first so odd sources ("Creature Token — X") still canonicalize.
  const base = (face?.type ?? '').replace(/\s*\bToken\b\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const data: Record<string, unknown> = {
    name: face?.name ?? src.sf?.name ?? 'Token',
    typeLine: `Token ${base || 'Copy'}`,
    rarity: 'common',
  };
  if (face?.oracle) data.abilities = face.oracle;
  if (face?.power != null && face?.toughness != null) {
    data.power = face.power;
    data.toughness = face.toughness;
  }
  if (face?.img) data.artUrl = face.img.replace('/normal/', '/art_crop/');
  const colors = new Set<string>();
  for (const m of (face?.mana ?? '').matchAll(/\{([^}]+)\}/g)) {
    for (const ch of m[1].toUpperCase()) if (ch in TOKEN_FRAME) colors.add(ch);
  }
  if (colors.size) {
    const frames = Object.keys(TOKEN_FRAME).filter((c) => colors.has(c)).map((c) => TOKEN_FRAME[c]);
    data.typeLineColor = frames.length === 1 ? frames[0] : frames;
  }
  return data;
}

/**
 * Copying a face-down permanent copies nothing but a nameless 2/2 creature —
 * never the hidden card. Scryfall's Manifest reminder token (Fate Reforged)
 * is exactly that card.
 */
const FACE_DOWN_TOKEN: NonNullable<PoolCard['sf']> = {
  id: 'e9f896d4-34b4-407d-be7e-bf7a69aaf811',
  name: 'Manifest',
  layout: 'token',
  faces: [
    {
      name: 'Manifest',
      img: 'https://cards.scryfall.io/normal/front/e/9/e9f896d4-34b4-407d-be7e-bf7a69aaf811.jpg?1783938662',
      type: 'Creature',
      power: '2',
      toughness: '2',
    },
  ],
};

/** Token copy of an existing card (C-7), rendered as a crucible token face. */
export const copyCardAsToken = undoable('copy as token', (guid: string, at: { x: number; y: number }): void => {
  const { s, me } = ctx();
  const src = s.pool[guid];
  if (!src) return;
  const token: PoolCard = s.cards[guid]?.faceDown
    ? { guid: newGuid(), ownerId: me, isToken: true, sf: FACE_DOWN_TOKEN }
    : { guid: newGuid(), ownerId: me, isToken: true, custom: tokenDataFrom(src) };
  createTokens([token], at);
});

export const removeToken = undoable('remove token', (guid: string): void => {
  const cur = currentCard(guid);
  sendState([cardEvent({ ...cur, del: true })]);
});

// --- Dice, turns, resets ----------------------------------------------------

function secureRandomInt(maxExclusive: number): number {
  return Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * maxExclusive);
}

export function rollDie(sides: number): void {
  const { myName } = ctx();
  const result = 1 + secureRandomInt(sides);
  sendState([
    logEvent({ kind: 'roll', text: `${myName} rolled a d${sides}: ${result}`, die: sides, result }),
  ]);
}

export function flipCoin(): void {
  const { myName } = ctx();
  const result = secureRandomInt(2) === 0 ? 'heads' : 'tails';
  sendState([logEvent({ kind: 'coin', text: `${myName} flipped ${result}`, result })]);
}

/**
 * G-5 shortcut: untap all + draw, announced as one turn. Claims the turn
 * marker — deliberately free-for-all, anyone may take it at any time ("I'm
 * done" is said out of band). The count bumps only when the marker actually
 * changes hands, so re-taking your own turn doesn't inflate it.
 */
export const takeTurn = undoable('take turn', (): void => {
  const { s, me, myName } = ctx();
  untapAll();
  drawCards(1);
  const alreadyMine = s.room?.turnPlayerId === me;
  const turn = (s.room?.turn ?? 0) + (alreadyMine ? 0 : 1);
  sendState([
    roomEvent({ gameId: s.room?.gameId ?? '', turnPlayerId: me, turn }),
    logEvent({ kind: 'turn', text: `${myName} took turn ${turn} (untap, upkeep, draw)` }),
  ]);
});

/**
 * Hand the turn marker to the next seat. Deliberately NO untap/upkeep/draw on
 * their behalf — the recipient still takes their own turn (which won't
 * re-bump the count, since the marker is already theirs).
 */
export const passTurn = undoable('pass turn', (): void => {
  const { s, me, myName } = ctx();
  const seated = [...s.players].sort((a, b) => a.seat - b.seat);
  const i = seated.findIndex((p) => p.playerId === me);
  const next = seated[(i + 1) % seated.length];
  if (!next || next.playerId === me) return;
  sendState([
    roomEvent({ gameId: s.room?.gameId ?? '', turnPlayerId: next.playerId, turn: (s.room?.turn ?? 0) + 1 }),
    logEvent({ kind: 'turn', text: `${myName} passed the turn to ${next.name}` }),
  ]);
});

/** G-7: new game. Broadcasts a fresh gameId; every seated client re-sets-up. */
export function resetGame(): void {
  const { s, myName } = ctx();
  clearUndo();
  sendState([
    roomEvent({ gameId: newGuid(), turnPlayerId: null, turn: 0 }),
    logEvent({ kind: 'reset', text: `${myName} started a new game — shuffle up!` }),
  ]);
}

// --- Deck import + per-game setup -------------------------------------------

/**
 * Broadcast my pool and set up my side. Starts a game only when there isn't
 * one yet; re-importing mid-game swaps just MY deck — my old cards leave the
 * table (wherever they are), the new deck is dealt, and everyone else's board,
 * life, and the turn carry on. Pool chunks precede the room event so the
 * game-change side effect always sees the NEW deck.
 */
export function importDeck(cards: PoolCard[]): void {
  const { s, me, myName } = ctx();
  const alreadyPlaying = Object.values(s.pool).some((p) => p.ownerId === me && !p.isToken);
  const bumpGame = !s.room?.gameId;
  const gameId = bumpGame ? newGuid() : s.room!.gameId;
  // Mid-game swap: tombstone my old deck's public cards BEFORE the new pool
  // lands, so peers never hold a card whose pool entry has vanished.
  const swapping = !bumpGame && alreadyPlaying && s.setupGameId === gameId;
  // importId must be lexicographically GREATER than any previous import of
  // mine — two imports in the same millisecond would otherwise race.
  let importId = `${Date.now().toString(36)}-${newGuid().slice(0, 8)}`;
  const prevImport = s.poolImports[me];
  if (prevImport && importId <= prevImport) importId = `${prevImport}1`;
  const events: StateEvent[] = [];
  if (swapping) {
    for (const c of Object.values(s.cards)) {
      if (c.ownerId === me && !c.del && !s.pool[c.guid]?.isToken) events.push(cardEvent({ ...c, del: true }));
    }
  }

  const CHUNK = 15;
  const nChunks = Math.ceil(cards.length / CHUNK) || 1;
  for (let i = 0; i < nChunks; i++) {
    events.push({
      t: 'pool',
      g: gameId,
      by: me,
      seq: nextSeq(`pool#${me}#${i}`),
      chunk: i,
      nChunks,
      importId,
      cards: cards.slice(i * CHUNK, (i + 1) * CHUNK),
    });
  }
  if (bumpGame) {
    events.push({ t: 'room', g: gameId, by: me, seq: nextSeq('room'), room: { gameId, turnPlayerId: null, turn: 0 } });
  }
  events.push({
    t: 'log', g: gameId, by: me, seq: nextLogSeq(),
    entry: {
      kind: 'note',
      text: swapping
        ? `${myName} swapped to a new deck (${cards.length} cards)`
        : `${myName} chose a deck (${cards.length} cards)`,
      ts: Date.now(),
    },
  });
  sendState(events);
  if (swapping) dealMySide(gameId, { freshPlayer: false });
  else runNewGameSetup(gameId);
}

/**
 * Shuffle up for gameId: library = my pool minus commanders, commanders to
 * the command zone, fresh player state. Idempotent per gameId.
 */
export function runNewGameSetup(gameId: string): void {
  const { s, me } = ctx();
  if (!gameId || s.setupGameId === gameId || s.session?.seat === null) return;
  if (!Object.values(s.pool).some((p) => p.ownerId === me && !p.isToken)) return;
  dealMySide(gameId, { freshPlayer: true });
}

/**
 * Deal my pool: shuffled library, opening hand, commanders to the command
 * zone. `freshPlayer` resets life/counters (new game); a mid-game deck swap
 * keeps them.
 */
function dealMySide(gameId: string, { freshPlayer }: { freshPlayer: boolean }): void {
  const { s, me } = ctx();
  const mine = Object.values(s.pool).filter((p) => p.ownerId === me && !p.isToken);
  if (mine.length === 0) return;
  s.markSetupDone(gameId);
  clearUndo(); // new deck: nothing before shuffle-up is undoable

  const commanders = mine.filter((p) => p.commander);
  const shuffledDeck = shuffled(mine.filter((p) => !p.commander).map((p) => p.guid));
  // Deal the opening hand automatically (Archidekt playtester behavior).
  const hand = shuffledDeck.slice(0, 7);
  const library = shuffledDeck.slice(7);
  s.setHidden(library, hand);

  const events: StateEvent[] = [];
  commanders.forEach((c, i) => {
    events.push({
      t: 'card', g: gameId, by: me, seq: nextSeq(`card#${c.guid}`),
      card: { ...defaultCardState(c.guid), zone: 'command', order: i + 1 },
    });
  });
  // Fresh game state via myPlayerState, NOT a bare literal: identity fields
  // (color, playmat, library order) must survive the reset — a literal without
  // color made players snap back to their seat-default color at shuffle-up.
  events.push(
    playerEvent(
      myPlayerState(
        freshPlayer
          ? { life: s.prefs.defaultLife, counters: {}, commanderDamage: {}, topRevealed: null }
          : { topRevealed: null }
      )
    )
  );
  syncHandReveals(events);
  sendState(events);
  flushHidden();

  // The decision moment: show the dealt hand with Keep / Mulligan.
  if (hand.length > 0) {
    void import('./uiStore').then(({ useUI }) => useUI.getState().openModal({ kind: 'openingHand' }));
  }
}

/**
 * Mulligan (Archidekt-style): the whole hand shuffles back in, draw 7 again.
 * London-rule bottoming is left to the player ("to library (bottom)").
 */
export const mulligan = undoable('mulligan', (): void => {
  const { s, me, myName } = ctx();
  const oldHand = s.hidden.hand;
  if (oldHand.length === 0 && s.hidden.library.length === 0) return;
  const deck = shuffled([...s.hidden.library, ...oldHand]);
  const hand = deck.slice(0, 7);
  s.setHidden(deck.slice(7), hand);

  const events: StateEvent[] = [];
  // Clear stale public markers (e.g. cards that were revealed from hand).
  for (const guid of oldHand) {
    if (s.cards[guid]) {
      const zone = hand.includes(guid) ? 'hand' : 'library';
      events.push(cardEvent({ ...currentCard(guid), zone, zoneOwnerId: me, revealed: false }));
    }
  }
  syncHandReveals(events);
  events.push(playerEvent(myPlayerState()));
  events.push(logEvent({ kind: 'shuffle', text: `${myName} took a mulligan` }));
  sendState(events);
});
