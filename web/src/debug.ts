/**
 * Console logging for every wire event, sent and received — Nathan wants eyes
 * on the traffic for now; later this may be suppressed or gated to dev builds.
 * High-frequency ephemerals (cursor / drag / presence) go to console.debug so
 * the default console level stays readable — flip devtools to "Verbose" to see
 * them stream.
 */

const NOISY = new Set(['cursor', 'drag', 'presence']);

export function logWire(
  dir: 'send' | 'recv',
  channel: 'state' | 'ephemeral',
  events: unknown[]
): void {
  for (const ev of events) {
    const t = (ev as { t?: string } | null)?.t ?? '?';
    const sink = channel === 'ephemeral' && NOISY.has(t) ? console.debug : console.log;
    sink(`[wire] ${dir === 'send' ? '⇡ send' : '⇣ recv'} ${channel}/${t}`, ev);
  }
}
