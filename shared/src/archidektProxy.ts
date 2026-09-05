/**
 * Archidekt deck proxy — the bit shared by both proxies (local-server in dev,
 * the room Lambda in prod) and the web client.
 *
 * Why a proxy at all: Archidekt pins CORS to http://localhost:3000, so the
 * browser can't read their API directly. Why the error shape matters: their
 * edge (Google Cloud Armor) 403s requests from cloud-hosted IPs with a tiny
 * HTML page, which is a different failure from Archidekt's own JSON 403 for a
 * private deck. Forwarding the raw upstream status used to make the browser
 * see a bare 403 from *our* API — indistinguishable from an auth problem.
 */

export const archidektDeckApiUrl = (deckId: string): string =>
  `https://archidekt.com/api/decks/${deckId.replace(/[^0-9]/g, '')}/`;

/** Any failure body the proxy can answer with (always alongside a 502). */
export interface ArchidektProxyFailure {
  error: 'archidekt_upstream' | 'archidekt_unreachable';
  upstreamStatus?: number;
  detail?: string;
}

/** Archidekt answered, but not 2xx. */
export interface ArchidektProxyError extends ArchidektProxyFailure {
  error: 'archidekt_upstream';
  /** What Archidekt actually answered (403, 404, 5xx…). */
  upstreamStatus: number;
  /**
   * Archidekt's own JSON `detail` when present (e.g. a private deck). Absent
   * when the answer came from their edge as HTML — that's the cloud-IP block.
   */
  detail?: string;
}

export function archidektProxyError(
  upstreamStatus: number,
  contentType: string | null | undefined,
  body: string
): ArchidektProxyError {
  let detail: string | undefined;
  if (contentType?.includes('json')) {
    try {
      const d = (JSON.parse(body) as { detail?: unknown })?.detail;
      if (typeof d === 'string' && d.trim()) detail = d;
    } catch {
      /* not JSON after all — treat as an edge/HTML failure */
    }
  }
  return detail === undefined
    ? { error: 'archidekt_upstream', upstreamStatus }
    : { error: 'archidekt_upstream', upstreamStatus, detail };
}
