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
import { sendState, flushHidden } from './connection';
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
  // Peers need this to know whether my hand is open for them to act on.
  merged.showHandToTable = s.prefs.showHandToTable;
  // Identity color + playmat ride along on every publish; the color always
  // resolves (seat default) so peers never have to guess.
  merged.color = s.prefs.playerColor ?? merged.color ?? seatDefaultColor(merged.seat).name;
  merged.playmat = s.prefs.playmatStyle ?? merged.playmat;
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

function addToHidden(guid: string, zone: 'library' | 'hand', libPos: 'top' | 'bottom' | number = 'top'): void {
  const { s } = ctx();
  if (zone === 'hand') {
    s.setHidden(s.hidden.library, [...s.hidden.hand, guid]);
    return;
  }
  const library = s.hidden.library.slice();
  if (libPos === 'top') library.unshift(guid);
  else if (libPos === 'bottom') library.push(guid);
  else library.splice(Math.min(Math.max(libPos, 0), library.length), 0, guid);
  s.setHidden(library, s.hidden.hand);
}

/** Reveal-sync for teaching mode: keep every hand card published as revealed. */
function syncHandReveals(events: StateEvent[]): void {
  const { s, me } = ctx();
  if (!s.prefs.showHandToTable) return;
  for (const guid of s.hidden.hand) {
    const cur = s.cards[guid];
    if (!cur || cur.zone !== 'hand' || !cur.revealed) {
      events.push(cardEvent({ ...currentCard(guid), zone: 'hand', zoneOwnerId: me, revealed: true }));
    }
  }
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

export function drawCards(n: number): void {
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
}

export interface MoveTarget {
  zone: ZoneName;
  x?: number;
  y?: number;
  libPos?: 'top' | 'bottom' | number;
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
  // Row full: pile onto the last slot with a visible offset.
  const last = slots[slots.length - 1];
  return { x: last.x + 40, y: last.y + 30 };
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
export function moveCard(guid: string, target: MoveTarget): void {
  const { s, me } = ctx();
  const cur = currentCard(guid);
  // Not caller-supplied: the destination zone's owner IS the card's owner for
  // every non-battlefield zone, so a mis-aimed drop can't relocate a card into
  // someone else's deck. Callers should gate on canPlaceIn() to avoid a
  // surprise teleport home; this is the backstop that makes it impossible.
  const zoneOwnerId = ownerOf(guid);
  const wasPublic = !!s.cards[guid] && !HIDDEN_ZONES.includes(s.cards[guid].zone);
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
    tapped: leavingBattlefield ? false : cur.tapped,
    faceDown: target.faceDown ?? (leavingBattlefield ? false : cur.faceDown),
    rotIndex: leavingBattlefield ? 0 : cur.rotIndex,
    counters: leavingBattlefield ? {} : cur.counters,
    revealed: false,
    order: ['graveyard', 'exile', 'command'].includes(target.zone) ? topOrder(target.zone, zoneOwnerId) : 0,
    libPos: target.zone === 'library' ? target.libPos ?? 'top' : undefined,
  };

  const events: StateEvent[] = [];
  const targetIsMyHidden = HIDDEN_ZONES.includes(target.zone) && zoneOwnerId === me;

  if (targetIsMyHidden) {
    addToHidden(guid, target.zone as 'library' | 'hand', target.libPos ?? 'top');
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
}

export function playFromHand(guid: string, x: number, y: number, faceDown = false): void {
  moveCard(guid, { zone: 'battlefield', x, y, faceDown });
}

export function setCardPosition(guid: string, x: number, y: number): void {
  const cur = currentCard(guid);
  const controllerId = cur.zone === 'battlefield' ? controllerAt(x, y, cur.controllerId) : cur.controllerId;
  const events: StateEvent[] = [cardEvent({ ...cur, x, y, controllerId })];
  const log = controlLog(guid, cur, controllerId);
  if (log) events.push(log);
  sendState(events);
}

export function moveCardsGroup(moves: { guid: string; x: number; y: number }[]): void {
  const events: StateEvent[] = [];
  for (const { guid, x, y } of moves) {
    const cur = currentCard(guid);
    const controllerId = cur.zone === 'battlefield' ? controllerAt(x, y, cur.controllerId) : cur.controllerId;
    events.push(cardEvent({ ...cur, x, y, controllerId }));
    const log = controlLog(guid, cur, controllerId);
    if (log) events.push(log);
  }
  sendState(events);
}

export function tapCards(guids: string[], tapped: boolean): void {
  const events = guids
    .map((g) => currentCard(g))
    .filter((c) => c.tapped !== tapped)
    .map((c) => cardEvent({ ...c, tapped }));
  if (events.length) sendState(events);
}

export function untapAll(): void {
  const { s, me, myName } = ctx();
  const mine = Object.values(s.cards).filter(
    (c) => c.zone === 'battlefield' && c.controllerId === me && c.tapped
  );
  if (!mine.length) return;
  sendState([...mine.map((c) => cardEvent({ ...c, tapped: false })), logEvent({ kind: 'note', text: `${myName} untapped` })]);
}

export function setRotIndex(guid: string, rotIndex: number): void {
  sendState([cardEvent({ ...currentCard(guid), rotIndex })]);
}

export function setFaceDown(guid: string, faceDown: boolean): void {
  sendState([cardEvent({ ...currentCard(guid), faceDown })]);
}

export function setCounter(guid: string, label: string, value: number): void {
  const cur = currentCard(guid);
  const counters = { ...cur.counters };
  if (value <= 0) delete counters[label];
  else counters[label] = value;
  sendState([cardEvent({ ...cur, counters })]);
}

export function revealFromHand(guid: string, revealed: boolean): void {
  const { me } = ctx();
  sendState([cardEvent({ ...currentCard(guid), zone: 'hand', zoneOwnerId: me, revealed })]);
}

export function setShowHandToTable(on: boolean): void {
  const { s, me } = ctx();
  s.setPrefs({ showHandToTable: on });
  const events: StateEvent[] = [];
  for (const guid of s.hidden.hand) {
    events.push(cardEvent({ ...currentCard(guid), zone: 'hand', zoneOwnerId: me, revealed: on }));
  }
  // Publish the flag itself, not just the reveals — peers gate whether they may
  // act on my hand on this, and an empty hand would otherwise announce nothing.
  events.push(playerEvent(myPlayerState()));
  sendState(events);
}

// --- Library operations -----------------------------------------------------

export function shuffleLibrary(quiet = false): void {
  const { s, myName } = ctx();
  s.setHidden(shuffled(s.hidden.library), s.hidden.hand);
  const events: StateEvent[] = [playerEvent(myPlayerState())];
  if (!quiet) events.push(logEvent({ kind: 'shuffle', text: `${myName} shuffled their library` }));
  sendState(events);
}

/** Commit a peek/scry/surveil: reorder the peeked window in place. */
export function commitPeek(opts: {
  seen: number;
  keepTop: string[];
  toBottom: string[];
  label?: string;
}): void {
  const { s, myName } = ctx();
  const rest = s.hidden.library.slice(opts.seen);
  s.setHidden([...opts.keepTop, ...rest, ...opts.toBottom], s.hidden.hand);
  sendState([
    playerEvent(myPlayerState()),
    logEvent({ kind: 'note', text: `${myName} ${opts.label ?? `looked at the top ${opts.seen}`}` }),
  ]);
}

export function setTopRevealed(on: boolean): void {
  const { s } = ctx();
  sendState([playerEvent(myPlayerState({ topRevealed: on ? s.hidden.library[0] ?? null : null }))]);
}

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

export function setLife(playerId: string, life: number): void {
  const { me } = ctx();
  const ps = playerId === me ? myPlayerState({ life }) : theirPlayerState(playerId, { life });
  sendState([playerEvent(ps)]);
}

export function setPlayerCounter(playerId: string, name: string, value: number): void {
  const { s, me } = ctx();
  const prev = s.playerStates[playerId]?.counters ?? {};
  const counters = { ...prev };
  if (value <= 0) delete counters[name];
  else counters[name] = value;
  const ps = playerId === me ? myPlayerState({ counters }) : theirPlayerState(playerId, { counters });
  sendState([playerEvent(ps)]);
}

/** Commander damage ticks the victim's life in the same event (README §2.1). */
export function dealCommanderDamage(victimId: string, commanderGuid: string, delta: number): void {
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
}

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

export function createTokens(tokens: PoolCard[], at: { x: number; y: number }): void {
  const { s, me, gameId, myName } = ctx();
  const events: StateEvent[] = [
    { t: 'pool', g: gameId, by: me, seq: 1, chunk: nextPoolChunk(), nChunks: 1, cards: tokens },
  ];
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
      })
    );
  });
  events.push(logEvent({ kind: 'note', text: `${myName} created ${tokens.length} token${tokens.length > 1 ? 's' : ''}` }));
  // Tokens need their pool entry to land with/before their card state; the
  // store applies optimistically in order and peers tolerate either order.
  sendState(events);
}

/** Token copy of an existing card (C-7). */
export function copyCardAsToken(guid: string, at: { x: number; y: number }): void {
  const { s, me } = ctx();
  const src = s.pool[guid];
  if (!src) return;
  createTokens([{ ...src, guid: newGuid(), ownerId: me, isToken: true, commander: undefined }], at);
}

export function removeToken(guid: string): void {
  const cur = currentCard(guid);
  sendState([cardEvent({ ...cur, del: true })]);
}

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
export function takeTurn(): void {
  const { s, me, myName } = ctx();
  untapAll();
  drawCards(1);
  const alreadyMine = s.room?.turnPlayerId === me;
  const turn = (s.room?.turn ?? 0) + (alreadyMine ? 0 : 1);
  sendState([
    roomEvent({ gameId: s.room?.gameId ?? '', turnPlayerId: me, turn }),
    logEvent({ kind: 'turn', text: `${myName} took turn ${turn} (untap, upkeep, draw)` }),
  ]);
}

/** G-7: new game. Broadcasts a fresh gameId; every seated client re-sets-up. */
export function resetGame(): void {
  const { s, myName } = ctx();
  sendState([
    roomEvent({ gameId: newGuid(), turnPlayerId: null, turn: 0 }),
    logEvent({ kind: 'reset', text: `${myName} started a new game — shuffle up!` }),
  ]);
}

// --- Deck import + per-game setup -------------------------------------------

/**
 * Broadcast my pool and set up my side. Bumps gameId (table-wide new game)
 * only when I re-import over a deck already in play. Pool chunks precede the
 * room event so the game-change side effect always sees the NEW deck.
 */
export function importDeck(cards: PoolCard[]): void {
  const { s, me, myName } = ctx();
  const alreadyPlaying = Object.values(s.pool).some((p) => p.ownerId === me && !p.isToken);
  const bumpGame = !s.room?.gameId || alreadyPlaying;
  const gameId = bumpGame ? newGuid() : s.room!.gameId;
  // importId must be lexicographically GREATER than any previous import of
  // mine — two imports in the same millisecond would otherwise race.
  let importId = `${Date.now().toString(36)}-${newGuid().slice(0, 8)}`;
  const prevImport = s.poolImports[me];
  if (prevImport && importId <= prevImport) importId = `${prevImport}1`;
  const events: StateEvent[] = [];

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
    entry: { kind: 'note', text: `${myName} imported a deck (${cards.length} cards)`, ts: Date.now() },
  });
  sendState(events);
  runNewGameSetup(gameId);
}

/**
 * Shuffle up for gameId: library = my pool minus commanders, commanders to
 * the command zone, fresh player state. Idempotent per gameId.
 */
export function runNewGameSetup(gameId: string): void {
  const { s, me } = ctx();
  if (!gameId || s.setupGameId === gameId || s.session?.seat === null) return;
  const mine = Object.values(s.pool).filter((p) => p.ownerId === me && !p.isToken);
  if (mine.length === 0) return;
  s.markSetupDone(gameId);

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
  events.push({
    t: 'player', g: gameId, by: me, seq: nextSeq(`player#${me}`),
    player: {
      playerId: me,
      seat: s.session!.seat ?? 0,
      name: s.session!.name,
      life: s.prefs.defaultLife,
      counters: {},
      commanderDamage: {},
      handCount: hand.length,
      libraryCount: library.length,
      topRevealed: null,
    },
  });
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
export function mulligan(): void {
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
}
