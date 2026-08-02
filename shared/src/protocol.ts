/**
 * Playmat wire protocol.
 *
 * Transport is AppSync Events (or the local emulation of it): at-most-once
 * delivery, no ordering guarantee. Every state event therefore carries
 * absolute values (never deltas) and a per-subject sequence number. A dropped
 * or reordered event is corrected by the next event for that subject.
 *
 * Channels (namespace is the first path segment):
 *   /state/{roomCode}      committed actions; persisted to the Board table
 *   /ephemeral/{roomCode}  cursor + in-flight drag + presence; never persisted
 */

export type ZoneName =
  | 'library'
  | 'hand'
  | 'battlefield'
  | 'graveyard'
  | 'exile'
  | 'command';

export const PUBLIC_ZONES: ZoneName[] = ['battlefield', 'graveyard', 'exile', 'command'];
export const HIDDEN_ZONES: ZoneName[] = ['library', 'hand'];

/**
 * Public state of one card, keyed by guid. Present only while the card is in
 * a public zone (or revealed from hand). An event with a hidden zone acts as
 * a removal marker: clients drop the card from the public board and rely on
 * the owner's count updates.
 */
export interface CardState {
  guid: string;
  zone: ZoneName;
  /** Seat owner of the physical card (whose deck/library it belongs to). */
  ownerId: string;
  /** Whose battlefield region it currently sits in / who controls it. */
  controllerId: string;
  /** Battlefield position in global table coordinates (seat 0 south). */
  x: number;
  y: number;
  tapped: boolean;
  faceDown: boolean;
  /** Which face is showing for multi-face cards (0 = front). */
  faceIndex: number;
  /** Index into the card's crucible rotations array. */
  rotIndex: number;
  counters: Record<string, number>;
  /** Ordering within stacked zones (graveyard/exile/command). Higher = top. */
  order: number;
  /** True while a hand card is revealed to the table (C-10). */
  revealed?: boolean;
  /** Tombstone: token removed from the game. */
  del?: boolean;
  /**
   * Whose zone the card is in, when not the card's owner (Z-6: any card can
   * move to any player's zones). Defaults to ownerId.
   */
  zoneOwnerId?: string;
  /**
   * Placement hint when a card is sent to a (hidden) library by someone other
   * than the zone owner: the owner's client integrates it at this position.
   * 'top' | 'bottom' | N (Nth from top, 0-based).
   */
  libPos?: 'top' | 'bottom' | number;
}

export interface PlayerState {
  playerId: string;
  seat: number;
  name: string;
  life: number;
  /** poison / energy / experience / custom, absent = 0 */
  counters: Record<string, number>;
  /**
   * Commander damage TAKEN by this player, keyed by the attacking commander's
   * card guid. Incrementing this also decrements `life` in the same event so
   * the two never need double entry (README §2.1).
   */
  commanderDamage: Record<string, number>;
  handCount: number;
  libraryCount: number;
  /**
   * This player's library order, index 0 = top. Published so every client can
   * browse and pull from any library, the same as graveyard/exile/command —
   * otherwise the library is the one zone you can't touch on another player's
   * board.
   *
   * This is a deliberate honor-system trade, matching "you may set an
   * opponent's life": every client now holds every deck's exact order, so a
   * player who goes looking can see their own next draw. The owner's hand stays
   * private (only `handCount`, plus individually revealed cards).
   *
   * Optional so snapshots written before this field still load.
   */
  library?: string[];
  /** Guid of the library top card while playing "with top revealed", else null. */
  topRevealed: string | null;
  /**
   * Teaching mode: this player's hand is continuously revealed to the table AND
   * open for other players to act on (play/discard/tuck on their behalf).
   * Optional so snapshots written before this field still load.
   */
  showHandToTable?: boolean;
}

export interface RoomState {
  /** Game epoch. "New game" mints a new id; items from old epochs are ignored. */
  gameId: string;
  turnPlayerId: string | null;
}

/** One face of a resolved card (Scryfall-derived). */
export interface PoolFace {
  name: string;
  /** Scryfall image URL ("normal" size). */
  img: string;
  mana?: string;
  type?: string;
  oracle?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
}

/**
 * An entry in a player's card pool: the immutable identity of one physical
 * card (27 Forests = 27 pool entries with distinct guids). Broadcast once at
 * import, then all game events refer to cards by guid only.
 */
export interface PoolCard {
  guid: string;
  ownerId: string;
  commander?: boolean;
  isToken?: boolean;
  /** Scryfall-resolved card. */
  sf?: {
    id: string;
    name: string;
    /** Scryfall layout: normal | transform | modal_dfc | split | flip | adventure | battle | ... */
    layout: string;
    faces: PoolFace[];
  };
  /**
   * Custom token: crucible CardData, rendered client-side by every peer.
   * Kept as an opaque record here so shared/ doesn't depend on mtg-crucible.
   */
  custom?: Record<string, unknown>;
}

export interface LogEntry {
  kind:
    | 'roll'
    | 'coin'
    | 'shuffle'
    | 'reveal'
    | 'zone'
    | 'life'
    | 'note'
    | 'turn'
    | 'reset'
    | 'join';
  text: string;
  /** roll/coin payload for animation on peers. */
  die?: number;
  result?: number | string;
  ts: number;
}

/** Seat roster snapshot, published by the server when someone joins/rejoins. */
export interface SeatsPayload {
  seats: { playerId: string; seat: number; name: string; joinedAt: number }[];
}

/** Events on /state/{roomCode}. All carry gameId `g`, publisher `by`, seq. */
export type StateEvent =
  | { t: 'card'; g: string; by: string; seq: number; card: CardState }
  | { t: 'player'; g: string; by: string; seq: number; player: PlayerState }
  | {
      t: 'pool';
      g: string;
      by: string;
      seq: number;
      chunk: number;
      nChunks: number;
      cards: PoolCard[];
      /**
       * Deck-import epoch (lexicographically increasing). All chunks of one
       * import share it; a NEW importId replaces the owner's previous
       * non-token pool entirely. Token pool events omit it (tokens accrete).
       */
      importId?: string;
    }
  | { t: 'room'; g: string; by: string; seq: number; room: RoomState }
  | { t: 'log'; g: string; by: string; seq: number; entry: LogEntry }
  | { t: 'seats'; g: string; by: string; seq: number; seats: SeatsPayload['seats'] };

/** Events on /ephemeral/{roomCode}. Best-effort, throttled, never persisted. */
export type EphemeralEvent =
  | { t: 'cursor'; by: string; x: number; y: number; ts: number }
  | { t: 'drag'; by: string; guid: string; x: number; y: number; ts: number }
  | { t: 'dragend'; by: string; guid: string; ts: number }
  | { t: 'presence'; by: string; name: string; seat: number | null; ts: number };

export type AnyEvent = StateEvent | EphemeralEvent;

export const stateChannel = (roomCode: string) => `/state/${roomCode}`;
export const ephemeralChannel = (roomCode: string) => `/ephemeral/${roomCode}`;

/**
 * DynamoDB sort key (and client-side state key) for a state event's subject.
 * One item per subject; each event overwrites the subject's item.
 */
export function subjectKey(e: StateEvent): string {
  switch (e.t) {
    case 'card':
      return `card#${e.card.guid}`;
    case 'player':
      return `player#${e.player.playerId}`;
    case 'pool':
      return `pool#${e.by}#${e.chunk}`;
    case 'room':
      return 'room';
    case 'seats':
      return 'seats';
    case 'log':
      return `log#${String(e.seq).padStart(9, '0')}#${e.by}`;
  }
}

/**
 * Deterministic per-subject ordering (E-2/E-3): higher seq wins; equal seq
 * tie-breaks on publisher id so every client picks the same winner.
 */
export function supersedes(
  incoming: { seq: number; by: string },
  current: { seq: number; by: string } | undefined
): boolean {
  if (!current) return true;
  if (incoming.seq !== current.seq) return incoming.seq > current.seq;
  return incoming.by > current.by;
}

/** Max events per publish (AppSync Events hard limit). */
export const MAX_EVENTS_PER_PUBLISH = 5;
/** Pool cards per pool event chunk — keeps each event comfortably small. */
export const POOL_CHUNK_SIZE = 15;
