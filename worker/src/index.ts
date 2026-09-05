/**
 * Playmat edge Worker.
 *
 *   GET  /archidekt/{deckId}   Archidekt deck JSON, same contract as the room
 *                              API's /archidekt route (see shared/archidektProxy)
 *   GET  /                     health
 *
 * Runs on Cloudflare because Archidekt's edge blocks public-cloud IPs (our
 * Lambda) but not Cloudflare's. Guard rails: browser callers must present an
 * allowlisted Origin, and each client IP is throttled (see `throttled`).
 */
import {
  archidektDeckApiUrl,
  archidektProxyError,
  type ArchidektProxyFailure,
} from '../../shared/src/archidektProxy';

/** Minimal shape of the rate-limit binding (wrangler.toml [[ratelimits]]). */
interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ARCHIDEKT_RL: RateLimiter;
  ALLOWED_ORIGINS: string;
}

const USER_AGENT = 'mtg-playmat/0.1';
/** Archidekt decks change slowly; a short edge cache spares them repeat hits. */
const UPSTREAM_CACHE_S = 60;

/**
 * Per-IP throttle, sliding window in isolate memory. Cloudflare's rate-limit
 * binding is "permissive, eventually consistent" by design — measured: 300+
 * requests allowed in ten minutes at a 30/min setting — so it can't be the
 * guard on its own. This window is exact but per isolate, so it's a deterrent
 * against a curl loop rather than a wall; the binding stays as a coarse
 * backstop across isolates. A human importing decks never gets near either.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, number[]>();
function throttled(ip: string, now = Date.now()): boolean {
  const cutoff = now - WINDOW_MS;
  let times = hits.get(ip);
  if (times) {
    while (times.length && times[0] < cutoff) times.shift();
  } else {
    times = [];
    hits.set(ip, times);
  }
  if (times.length >= MAX_PER_WINDOW) return true;
  times.push(now);
  // Keep the map bounded: sweep idle keys once it grows past a few thousand.
  if (hits.size > 5000) {
    for (const [key, t] of hits) if (!t.length || t[t.length - 1] < cutoff) hits.delete(key);
  }
  return false;
}

function corsHeaders(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(status: number, body: unknown, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

async function archidekt(deckId: string, origin: string, env: Env, request: Request): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (throttled(ip) || !(await env.ARCHIDEKT_RL.limit({ key: ip })).success) {
    const failure: ArchidektProxyFailure = { error: 'rate_limited' };
    return json(429, failure, { ...corsHeaders(origin), 'Retry-After': '60' });
  }

  let res: Response;
  try {
    res = await fetch(archidektDeckApiUrl(deckId), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      cf: { cacheTtl: UPSTREAM_CACHE_S, cacheEverything: true },
    });
  } catch (err) {
    console.error('archidekt fetch threw', err);
    const failure: ArchidektProxyFailure = { error: 'archidekt_unreachable' };
    return json(502, failure, corsHeaders(origin));
  }

  const text = await res.text();
  if (!res.ok) {
    const failure = archidektProxyError(res.status, res.headers.get('content-type'), text);
    console.warn('archidekt upstream failure', JSON.stringify(failure));
    return json(502, failure, corsHeaders(origin));
  }
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' && request.method === 'GET') {
      return new Response('playmat worker ok\n', { headers: { 'Content-Type': 'text/plain' } });
    }

    const m = path.match(/^\/archidekt\/(\d+)$/);
    if (!m) return json(404, { error: `No route: ${request.method} ${path}` });

    // Browser gate: Origin must be one of ours. curl-style callers without an
    // Origin are refused too — this is Playmat's proxy, not a public one.
    const origin = request.headers.get('Origin') ?? '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(origin)) {
      const failure: ArchidektProxyFailure = { error: 'origin_not_allowed' };
      return json(403, failure);
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return json(405, { error: 'GET only' }, corsHeaders(origin));

    return archidekt(m[1], origin, env, request);
  },
} satisfies ExportedHandler<Env>;
