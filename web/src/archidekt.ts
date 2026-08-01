/**
 * Archidekt deck import (D-2). Their API blocks browser CORS, so we go via
 * the room API proxy (local-server in dev, the Lambda in prod), which also
 * sets the courteous User-Agent. Card identity comes back as Scryfall uids,
 * so resolution afterwards is exact, and the "Commander" category gives us
 * D-5 inference for free.
 */
import { config } from './config';

export interface ArchidektEntry {
  id: string; // scryfall uid
  count: number;
  commander: boolean;
  name: string;
}

export function parseArchidektUrl(url: string): string | null {
  const m = url.match(/archidekt\.com\/(?:decks|api\/decks)\/(\d+)/);
  return m ? m[1] : null;
}

export async function fetchArchidektDeck(deckId: string): Promise<{ name: string; entries: ArchidektEntry[] }> {
  const res = await fetch(`${config.apiBase}/archidekt/${deckId}`);
  if (!res.ok) throw new Error(`Archidekt fetch failed (${res.status})`);
  const deck = await res.json();

  // Categories marked premier=false + includedInDeck=false (Maybeboard,
  // Sideboard) are excluded. "Commander" category marks commanders.
  const excluded = new Set<string>(
    (deck.categories ?? [])
      .filter((c: any) => c.includedInDeck === false)
      .map((c: any) => String(c.name).toLowerCase())
  );

  const entries: ArchidektEntry[] = [];
  for (const item of deck.cards ?? []) {
    const categories: string[] = (item.categories ?? []).map((c: string) => c.toLowerCase());
    const primary = categories[0];
    if (primary && excluded.has(primary)) continue;
    const uid: string | undefined = item.card?.uid;
    if (!uid) continue;
    entries.push({
      id: uid,
      count: item.quantity ?? 1,
      commander: categories.some((c) => c.startsWith('commander')),
      name: item.card?.oracleCard?.name ?? 'Unknown',
    });
  }
  return { name: deck.name ?? `Archidekt deck ${deckId}`, entries };
}
