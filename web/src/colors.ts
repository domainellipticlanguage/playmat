/**
 * Player identity colors. Deliberately NOT the five mana colors — purple,
 * yellow, orange, teal, pink, slate — so nobody reads a player's color as
 * W/U/B/R/G. The name doubles as the stock playmat pattern filename under
 * web/public/playmats/ (keep in sync with scripts/gen-art.mjs).
 */
import type { PlayerState, PoolCard } from '@playmat/shared';

export interface PlayerColor {
  name: string;
  hex: string;
}

export const PLAYER_PALETTE: PlayerColor[] = [
  { name: 'purple', hex: '#9a6fd8' },
  { name: 'yellow', hex: '#d7bd45' },
  { name: 'orange', hex: '#e0813c' },
  { name: 'teal', hex: '#3ab5a5' },
  { name: 'pink', hex: '#d670a4' },
  { name: 'slate', hex: '#93a3b8' },
];

/** A seat's default color when the player hasn't picked one. */
export function seatDefaultColor(seat: number): PlayerColor {
  return PLAYER_PALETTE[Math.abs(seat) % PLAYER_PALETTE.length];
}

/** Resolve a palette name (from PlayerState.color) with the seat fallback. */
export function paletteColor(name: string | undefined, seat: number): PlayerColor {
  return PLAYER_PALETTE.find((c) => c.name === name) ?? seatDefaultColor(seat);
}

/**
 * A player's mat background image, from their published choice: a custom URL,
 * their commander's art crop, or the stock pattern for their color.
 */
export function playmatImageUrl(
  ps: PlayerState | undefined,
  seat: number,
  pool: Record<string, PoolCard>
): string {
  const choice = ps?.playmat ?? 'color';
  if (choice.startsWith('url:')) return choice.slice(4);
  if (choice === 'commander' && ps) {
    const cmdr = Object.values(pool).find((p) => p.ownerId === ps.playerId && p.commander);
    const img = cmdr?.sf?.faces[0]?.img;
    // Scryfall images share one path scheme, so the art crop is a substring swap.
    if (img) return img.replace('/normal/', '/art_crop/');
  }
  return `/playmats/${paletteColor(ps?.color, seat).name}.jpg`;
}
