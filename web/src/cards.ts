/**
 * PoolCard -> mtg-crucible display plumbing.
 *
 * Real cards use Scryfall images directly in MtgCardDisplayData (no
 * renderCard call). Custom tokens are rendered in-browser by crucible.
 * Rotations come from crucible's standalone computeRotations; one synced
 * rotIndex covers both orientations (flip/battle/split) and faces
 * (transform/MDFC — the y:180 entries mean "show back face").
 */
import { useEffect, useState } from 'react';
import { computeRotations } from 'mtg-crucible/parser';
import { renderCard, toDisplayCard } from 'mtg-crucible';
import type { CardData, MtgCardDisplayData, Rotation } from 'mtg-crucible';
import type { PoolCard, PoolFace } from '@playmat/shared';

/** Scryfall layout -> crucible template + linkType for rotation math. */
function layoutToCrucible(layout: string): Partial<CardData> {
  switch (layout) {
    case 'transform':
      return { cardTemplate: 'transform_front', linkType: 'transform', linkedCard: { name: 'b' } };
    case 'modal_dfc':
      return { cardTemplate: 'mdfc_front', linkType: 'modal_dfc', linkedCard: { name: 'b' } };
    case 'flip':
      return { cardTemplate: 'flip', linkType: 'flip', linkedCard: { name: 'b' } };
    case 'split':
      return { cardTemplate: 'split', linkType: 'split', linkedCard: { name: 'b' } };
    case 'adventure':
      return { cardTemplate: 'adventure', linkType: 'adventure', linkedCard: { name: 'b' } };
    case 'battle':
      return { cardTemplate: 'battle', linkType: 'transform', linkedCard: { name: 'b' } };
    case 'room':
      return { cardTemplate: 'room', linkType: 'room', linkedCard: { name: 'b' } };
    default:
      return { cardTemplate: 'standard' };
  }
}

const rotationsCache = new Map<string, Rotation[]>();

/**
 * Synced rotation states for a card. Battles drop the leading null rotation
 * so they sit sideways by default (they enter the battlefield tilted).
 */
export function cardRotations(pool: PoolCard): Rotation[] {
  const key = pool.sf ? `${pool.sf.layout}` : pool.custom ? 'custom' : 'standard';
  const cached = rotationsCache.get(key);
  if (cached) return cached;

  let rotations: Rotation[];
  if (pool.sf) {
    rotations = computeRotations({ name: pool.sf.name, ...layoutToCrucible(pool.sf.layout) });
    if (pool.sf.layout === 'battle') {
      rotations = rotations.filter((r, i) => !(i === 0 && r.x === 0 && r.y === 0 && r.z === 0));
    }
    // Aftermath detection: Scryfall calls these "split"; the second half reads
    // sideways-left. computeRotations already handled split; good enough.
  } else {
    rotations = [{ x: 0, y: 0, z: 0 }];
  }
  rotationsCache.set(key, rotations);
  return rotations;
}

export function rotationAt(pool: PoolCard, rotIndex: number): Rotation {
  const rots = cardRotations(pool);
  return rots[rotIndex % rots.length] ?? { x: 0, y: 0, z: 0 };
}

/** Which face a rotation state shows (y:180 => back). */
export function faceIndexAt(pool: PoolCard, rotIndex: number): number {
  const rot = rotationAt(pool, rotIndex);
  const backish = Math.round(Math.abs(rot.y) / 180) % 2 === 1;
  return backish ? 1 : 0;
}

export function faceAt(pool: PoolCard, rotIndex: number): PoolFace | null {
  if (!pool.sf) return null;
  const idx = faceIndexAt(pool, rotIndex);
  return pool.sf.faces[Math.min(idx, pool.sf.faces.length - 1)] ?? pool.sf.faces[0] ?? null;
}

/** True when this card has more than one synced rotation/face state. */
export function hasRotationStates(pool: PoolCard): boolean {
  return cardRotations(pool).length > 1;
}

export const CARD_BACK_URL =
  'https://backs.scryfall.io/normal/2/2/222b7a3b-2321-4d4c-af19-19338b134971.jpg';

// ---------------------------------------------------------------------------
// Mana symbols (crucible's own CDN assets, symbols/mana/*.svg)
// ---------------------------------------------------------------------------

const WUBRG = ['W', 'U', 'B', 'R', 'G'] as const;

/** Vendored crucible mana symbols (web/public/mana/, incl. colorless c.svg). */
export function manaSymbolUrl(color: string): string {
  return `/mana/${color.toLowerCase()}.svg`;
}

/**
 * A deck's color identity in WUBRG order. With commanders present, identity
 * comes from their mana costs + rules text (the actual rule); otherwise from
 * mana costs across the whole list.
 */
export function deckColorIdentity(cards: Pick<PoolCard, 'sf' | 'commander'>[]): string[] {
  const found = new Set<string>();
  const scan = (text?: string) => {
    if (!text) return;
    for (const m of text.matchAll(/\{([^}]+)\}/g)) {
      for (const ch of m[1].toUpperCase()) if ((WUBRG as readonly string[]).includes(ch)) found.add(ch);
    }
  };
  const commanders = cards.filter((c) => c.commander);
  if (commanders.length) {
    for (const c of commanders) {
      for (const f of c.sf?.faces ?? []) {
        scan(f.mana);
        scan(f.oracle);
      }
    }
  } else {
    for (const c of cards) for (const f of c.sf?.faces ?? []) scan(f.mana);
  }
  return WUBRG.filter((c) => found.has(c));
}

/**
 * Display data for MtgCard, pinned to one synced state: the current face's
 * image only, no rotations array — so the component's own click-to-rotate
 * stays inert and every player sees the same thing.
 */
export function displayDataFor(pool: PoolCard, rotIndex: number, faceDown: boolean): MtgCardDisplayData {
  if (faceDown || (!pool.sf && !pool.custom)) {
    return {
      frontFaceImageUrl: CARD_BACK_URL,
      name: 'Face-down card',
      scryfallJson: '',
      scryfallText: '',
      crucibleText: '',
    };
  }
  const face = pool.sf ? faceAt(pool, rotIndex)! : null;
  return {
    frontFaceImageUrl: face?.img || CARD_BACK_URL,
    name: face?.name ?? pool.sf?.name ?? 'Card',
    scryfallJson: '',
    scryfallText: face?.oracle ?? '',
    crucibleText: '',
  };
}

/** The z-rotation (degrees) to apply for the current synced state. */
export function zRotation(pool: PoolCard, rotIndex: number): number {
  return rotationAt(pool, rotIndex).z;
}

// ---------------------------------------------------------------------------
// Custom tokens: rendered in-browser by crucible on every client.
// ---------------------------------------------------------------------------

const customCache = new Map<string, MtgCardDisplayData>();
const customPending = new Map<string, Promise<MtgCardDisplayData | null>>();

export function renderCustomCard(guid: string, data: Record<string, unknown>): Promise<MtgCardDisplayData | null> {
  const hit = customCache.get(guid);
  if (hit) return Promise.resolve(hit);
  let pending = customPending.get(guid);
  if (!pending) {
    pending = renderCard(data as CardData, { quality: 'low', format: 'jpeg' })
      .then((rendered) => {
        const display = toDisplayCard(rendered);
        customCache.set(guid, display);
        return display;
      })
      .catch((err) => {
        console.warn('custom token render failed', err);
        return null;
      });
    customPending.set(guid, pending);
  }
  return pending;
}

/** React hook: display data for a custom-token pool entry (null while rendering). */
export function useCustomDisplay(pool: PoolCard | undefined): MtgCardDisplayData | null {
  const isCustom = !!pool?.custom;
  const guid = pool?.guid;
  const [display, setDisplay] = useState<MtgCardDisplayData | null>(
    isCustom && guid ? customCache.get(guid) ?? null : null
  );
  useEffect(() => {
    if (!isCustom || !guid || !pool?.custom) return;
    let alive = true;
    void renderCustomCard(guid, pool.custom).then((d) => {
      if (alive && d) setDisplay(d);
    });
    return () => {
      alive = false;
    };
  }, [guid, isCustom]);
  return isCustom ? display : null;
}

/**
 * Effective power/toughness with +1/+1 and -1/-1 counters (Archidekt-style
 * convenience). Non-numeric bases like star/star render as base±n.
 */
export function effectivePT(
  face: PoolFace | null,
  counters: Record<string, number>
): { p: string; t: string } | null {
  if (!face || face.power === undefined || face.toughness === undefined) return null;
  const delta = (counters['+1/+1'] ?? 0) - (counters['-1/-1'] ?? 0);
  const fmt = (base: string): string => {
    const n = Number(base);
    if (Number.isFinite(n)) return String(n + delta);
    return delta === 0 ? base : `${base}${delta > 0 ? '+' : ''}${delta}`;
  };
  return { p: fmt(face.power), t: fmt(face.toughness) };
}
