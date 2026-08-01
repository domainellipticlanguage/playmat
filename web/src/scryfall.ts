/**
 * Client-side Scryfall resolution. POST /cards/collection takes up to 75
 * identifiers per request, so a Commander deck resolves in 2 round trips.
 * Scryfall supports CORS for exactly this kind of client-side use.
 */
import type { DeckEntry, PoolCard, PoolFace } from '@playmat/shared';
import { newGuid } from '@playmat/shared';

const COLLECTION_URL = 'https://api.scryfall.com/cards/collection';

export interface ScryfallCard {
  id: string;
  name: string;
  layout: string;
  type_line?: string;
  oracle_text?: string;
  mana_cost?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
  image_uris?: { normal?: string; large?: string };
  card_faces?: {
    name: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    power?: string;
    toughness?: string;
    loyalty?: string;
    defense?: string;
    image_uris?: { normal?: string; large?: string };
  }[];
}

export interface ResolvedDeck {
  /** One PoolCard per physical card (27 Forests -> 27 guids). */
  cards: PoolCard[];
  notFound: string[];
}

function facesOf(card: ScryfallCard): PoolFace[] {
  const rootImg = card.image_uris?.normal ?? card.image_uris?.large ?? '';
  if (card.card_faces && card.card_faces.length > 0) {
    const faceImgs = card.card_faces.map((f) => f.image_uris?.normal ?? f.image_uris?.large);
    if (faceImgs.every(Boolean)) {
      // True two-image cards: transform, modal_dfc, battle DFCs, reversible.
      return card.card_faces.map((f, i) => ({
        name: f.name,
        img: faceImgs[i]!,
        mana: f.mana_cost || undefined,
        type: f.type_line || undefined,
        oracle: f.oracle_text || undefined,
        power: f.power,
        toughness: f.toughness,
        loyalty: f.loyalty,
        defense: f.defense,
      }));
    }
    // Single-image multi-face cards: split, adventure, flip, aftermath.
    // Keep both faces' text but share the root image.
    return card.card_faces.map((f) => ({
      name: f.name,
      img: rootImg,
      mana: f.mana_cost || undefined,
      type: f.type_line || undefined,
      oracle: f.oracle_text || undefined,
      power: f.power,
      toughness: f.toughness,
      loyalty: f.loyalty,
      defense: f.defense,
    }));
  }
  return [
    {
      name: card.name,
      img: rootImg,
      mana: card.mana_cost || undefined,
      type: card.type_line || undefined,
      oracle: card.oracle_text || undefined,
      power: card.power,
      toughness: card.toughness,
      loyalty: card.loyalty,
      defense: card.defense,
    },
  ];
}

export function toPoolCard(card: ScryfallCard, ownerId: string, commander = false, isToken = false): PoolCard {
  return {
    guid: newGuid(),
    ownerId,
    commander: commander || undefined,
    isToken: isToken || undefined,
    sf: { id: card.id, name: card.name, layout: card.layout, faces: facesOf(card) },
  };
}

async function fetchCollection(identifiers: Record<string, string>[]): Promise<{ data: ScryfallCard[]; not_found: Record<string, string>[] }> {
  const res = await fetch(COLLECTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifiers }),
  });
  if (!res.ok) throw new Error(`Scryfall ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Resolve deck entries by name into per-physical-card PoolCards. */
export async function resolveDeckByNames(entries: DeckEntry[], ownerId: string): Promise<ResolvedDeck> {
  const uniqueNames = [...new Set(entries.map((e) => e.name))];
  const byName = new Map<string, ScryfallCard>();
  const notFound: string[] = [];

  for (let i = 0; i < uniqueNames.length; i += 75) {
    const batch = uniqueNames.slice(i, i + 75);
    const result = await fetchCollection(batch.map((name) => ({ name })));
    for (const card of result.data) byName.set(card.name.toLowerCase(), card);
    for (const miss of result.not_found ?? []) notFound.push(String(miss.name));
    if (i + 75 < uniqueNames.length) await new Promise((r) => setTimeout(r, 120));
  }

  const cards: PoolCard[] = [];
  for (const entry of entries) {
    // Scryfall returns canonical names; match loosely (front-face prefix too).
    const key = entry.name.toLowerCase();
    let card = byName.get(key);
    if (!card) {
      card = [...byName.values()].find(
        (c) => c.name.toLowerCase().startsWith(key) || key.startsWith(c.name.toLowerCase().split(' // ')[0])
      );
    }
    if (!card) {
      if (!notFound.includes(entry.name)) notFound.push(entry.name);
      continue;
    }
    for (let n = 0; n < entry.count; n++) cards.push(toPoolCard(card, ownerId, entry.commander));
  }
  return { cards, notFound };
}

/** Resolve by Scryfall ids (Archidekt gives us uids). Order preserved per input. */
export async function resolveByIds(
  items: { id: string; count: number; commander: boolean }[],
  ownerId: string
): Promise<ResolvedDeck> {
  const uniqueIds = [...new Set(items.map((i) => i.id))];
  const byId = new Map<string, ScryfallCard>();
  const notFound: string[] = [];
  for (let i = 0; i < uniqueIds.length; i += 75) {
    const batch = uniqueIds.slice(i, i + 75);
    const result = await fetchCollection(batch.map((id) => ({ id })));
    for (const card of result.data) byId.set(card.id, card);
    for (const miss of result.not_found ?? []) notFound.push(String(miss.id));
    if (i + 75 < uniqueIds.length) await new Promise((r) => setTimeout(r, 120));
  }
  const cards: PoolCard[] = [];
  for (const item of items) {
    const card = byId.get(item.id);
    if (!card) continue;
    for (let n = 0; n < item.count; n++) cards.push(toPoolCard(card, ownerId, item.commander));
  }
  return { cards, notFound };
}

/** Token search via Scryfall (C-7): fuzzy name search restricted to tokens. */
export async function searchTokens(query: string): Promise<ScryfallCard[]> {
  const q = encodeURIComponent(`${query} t:token`);
  const res = await fetch(`https://api.scryfall.com/cards/search?q=${q}&unique=cards&order=name`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Scryfall search ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).slice(0, 24);
}
