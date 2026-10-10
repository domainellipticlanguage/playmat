/**
 * Archidekt deck import (D-2). Their API blocks browser CORS, so we go via a
 * proxy that sets the courteous User-Agent: local-server in dev, and in prod
 * the Cloudflare Worker (worker/) — Archidekt's edge 403s AWS egress, so the
 * Lambda's /archidekt route can't be used from the live site. Card identity
 * comes back as Scryfall uids, so resolution afterwards is exact, and the
 * "Commander" category gives us D-5 inference for free.
 */
import type { ArchidektProxyFailure } from '@playmat/shared';
import { config } from './config';

export interface ArchidektEntry {
  id: string; // scryfall uid
  count: number;
  commander: boolean;
  name: string;
  /** Printing, so the mirrored text list re-resolves to the same card. */
  set?: string;
  cn?: string;
}

export function parseArchidektUrl(url: string): string | null {
  const m = url.match(/archidekt\.com\/(?:decks|api\/decks)\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Turn a proxy failure into something the user can act on. The important
 * case: Archidekt's edge blocks cloud-hosted IPs, so the deployed proxy gets a
 * 403 for *every* deck — the fix on the user's side is Archidekt's own text
 * export pasted into the decklist box, which the import modal already accepts.
 */
export function describeArchidektFailure(status: number, failure?: Partial<ArchidektProxyFailure>): string {
  const upstream = failure?.upstreamStatus;
  if (upstream === 403 && failure?.detail) {
    return `Archidekt refused the deck (${failure.detail}). If it's private, make it public or unlisted — or paste its exported decklist below.`;
  }
  if (upstream === 403) {
    return "Archidekt is blocking requests from Playmat's server. Workaround: on Archidekt open the deck → Export → copy the text list, paste it below, and hit Resolve.";
  }
  if (upstream === 404) return 'Archidekt has no deck at that URL — check the link.';
  if (upstream) return `Archidekt answered ${upstream}; try again in a moment, or paste the exported decklist below.`;
  if (failure?.error === 'archidekt_unreachable') return 'Could not reach Archidekt; try again in a moment, or paste the exported decklist below.';
  if (failure?.error === 'rate_limited') return 'Too many deck fetches in the last minute — wait a bit and try again, or paste the exported decklist below.';
  return `Archidekt fetch failed (${status}).`;
}

export async function fetchArchidektDeck(deckId: string): Promise<{ name: string; entries: ArchidektEntry[] }> {
  const res = await fetch(`${config.archidektBase}/${deckId}`);
  if (!res.ok) {
    const failure = (await res.json().catch(() => undefined)) as Partial<ArchidektProxyFailure> | undefined;
    throw new Error(describeArchidektFailure(res.status, failure));
  }
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
      set: item.card?.edition?.editioncode || undefined,
      cn: item.card?.collectorNumber || undefined,
    });
  }
  return { name: deck.name ?? `Archidekt deck ${deckId}`, entries };
}
