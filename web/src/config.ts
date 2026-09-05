/**
 * Endpoint configuration. In dev everything is same-origin (vite proxies to
 * local-server). Deployed builds bake in the real endpoints via VITE_ vars.
 */

const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';

export const config = {
  /** Room API base, no trailing slash. */
  apiBase: (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '/api',
  /**
   * Archidekt deck fetch base, no trailing slash: `${base}/{deckId}`. In dev
   * the local server proxies fine from a home IP; in prod Archidekt blocks
   * AWS, so the deploy points this at the Cloudflare Worker (see worker/).
   */
  archidektBase:
    (import.meta.env.VITE_ARCHIDEKT_BASE as string | undefined)?.replace(/\/$/, '') ||
    `${(import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '/api'}/archidekt`,
  /** AppSync Events realtime endpoint (or the local emulation). */
  realtimeUrl:
    (import.meta.env.VITE_REALTIME_URL as string | undefined) ||
    `${wsScheme}://${location.host}/event/realtime`,
  /** The "host" field in auth headers — the Events HTTP DNS in prod. */
  eventsHost: (import.meta.env.VITE_EVENTS_HOST as string | undefined) || location.host,
};
