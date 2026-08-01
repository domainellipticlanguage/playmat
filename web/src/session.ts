/**
 * localStorage persistence: display name, last deck, rejoin credentials, and
 * the owner's hidden zones (library order + hand) per room.
 */
import type { HiddenState } from '@playmat/shared';

const KEY = 'playmat';

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
};
