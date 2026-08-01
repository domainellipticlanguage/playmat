/**
 * localStorage persistence: display name, last deck, rejoin credentials, and
 * the owner's hidden zones (library order + hand) per room.
 */
import type { HiddenState, PoolCard } from '@playmat/shared';

const KEY = 'playmat';

/** A resolved deck saved for reuse — card data without per-game identity. */
export interface SavedDeck {
  id: string;
  name: string;
  savedAt: number;
  count: number;
  commanders: string[];
  cards: Omit<PoolCard, 'guid' | 'ownerId'>[];
}

export interface StoredSession {
  roomCode: string;
  playerId: string;
  seat: number | null;
  token: string;
  rejoinKey: string;
  name: string;
}

interface Persisted {
  name?: string;
  decklistText?: string;
  archidektUrl?: string;
  lastSession?: StoredSession;
  /** roomCode -> own hidden zones (mirror of the server copy). */
  hidden?: Record<string, HiddenState>;
  prefs?: Record<string, unknown>;
  decks?: SavedDeck[];
}

function load(): Persisted {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

function save(p: Persisted): void {
  localStorage.setItem(KEY, JSON.stringify(p));
}

export const persisted = {
  get: load,
  patch(partial: Partial<Persisted>): void {
    save({ ...load(), ...partial });
  },
  saveHidden(roomCode: string, hidden: HiddenState): void {
    const p = load();
    p.hidden = { ...(p.hidden ?? {}), [roomCode]: hidden };
    // Cap stored rooms so localStorage doesn't grow forever.
    const entries = Object.entries(p.hidden);
    if (entries.length > 8) p.hidden = Object.fromEntries(entries.slice(-8));
    save(p);
  },
  getHidden(roomCode: string): HiddenState | undefined {
    return load().hidden?.[roomCode];
  },
  /** Save a resolved deck for one-click reuse. Same name updates in place. */
  saveDeck(name: string, cards: PoolCard[]): void {
    const p = load();
    const deck: SavedDeck = {
      id: crypto.randomUUID(),
      name,
      savedAt: Date.now(),
      count: cards.length,
      commanders: cards.filter((c) => c.commander).map((c) => c.sf?.name ?? '?'),
      cards: cards.map(({ guid: _g, ownerId: _o, ...rest }) => rest),
    };
    const decks = (p.decks ?? []).filter((d) => d.name !== name);
    decks.unshift(deck);
    p.decks = decks.slice(0, 12); // cap so localStorage stays comfortable
    try {
      save(p);
    } catch {
      // Quota — drop oldest decks and retry once.
      p.decks = decks.slice(0, 4);
      try {
        save(p);
      } catch {
        /* give up quietly */
      }
    }
  },
  listDecks(): SavedDeck[] {
    return load().decks ?? [];
  },
  deleteDeck(id: string): void {
    const p = load();
    p.decks = (p.decks ?? []).filter((d) => d.id !== id);
    save(p);
  },
};
