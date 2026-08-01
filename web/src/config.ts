/**
 * Endpoint configuration. In dev everything is same-origin (vite proxies to
 * local-server). Deployed builds bake in the real endpoints via VITE_ vars.
 */

const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';

export const config = {
  /** Room API base, no trailing slash. */
  apiBase: (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '/api',
  /** AppSync Events realtime endpoint (or the local emulation). */
  realtimeUrl:
    (import.meta.env.VITE_REALTIME_URL as string | undefined) ||
    `${wsScheme}://${location.host}/event/realtime`,
  /** The "host" field in auth headers — the Events HTTP DNS in prod. */
  eventsHost: (import.meta.env.VITE_EVENTS_HOST as string | undefined) || location.host,
};
