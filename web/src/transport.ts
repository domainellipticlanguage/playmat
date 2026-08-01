/**
 * AppSync Events WebSocket client. Speaks the documented wire protocol, which
 * both the real endpoint and local-server implement:
 *   subprotocols: ['header-<b64url auth>', 'aws-appsync-event-ws']
 *   messages: connection_init/ack, subscribe(_success/_error),
 *             publish(_success/_error), data, ka, unsubscribe
 *
 * Reconnects with jittered exponential backoff. On reconnect the app must
 * re-fetch a snapshot rather than replay (E-6) — subscribe to `reconnected`.
 */
import { config } from './config';

export type TransportStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'dead';

type EventHandler = (event: unknown) => void;

interface PendingSub {
  channel: string;
  handler: EventHandler;
  resolve?: () => void;
  reject?: (err: Error) => void;
}

const b64url = (s: string) =>
  btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class EventsClient {
  private ws: WebSocket | null = null;
  private token: string;
  private subs = new Map<string, PendingSub>(); // subId -> sub
  private outbox: { channel: string; events: string[] }[] = [];
  private status: TransportStatus = 'idle';
  private statusListeners = new Set<(s: TransportStatus) => void>();
  private reconnectListeners = new Set<() => void>();
  private backoff = 500;
  private closedByUser = false;
  private kaTimer: ReturnType<typeof setTimeout> | null = null;
  private kaTimeoutMs = 300_000;
  private everConnected = false;

  constructor(token: string) {
    this.token = token;
  }

  onStatus(cb: (s: TransportStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  /** Fires after a NEW connection replaces a dropped one (snapshot refetch time). */
  onReconnected(cb: () => void): () => void {
    this.reconnectListeners.add(cb);
    return () => this.reconnectListeners.delete(cb);
  }

  private setStatus(s: TransportStatus) {
    this.status = s;
    for (const cb of this.statusListeners) cb(s);
  }

  private authObject(): Record<string, string> {
    return { host: config.eventsHost, Authorization: this.token };
  }

  connect(): Promise<void> {
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
      const authProto = `header-${b64url(JSON.stringify(this.authObject()))}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(config.realtimeUrl, [authProto, 'aws-appsync-event-ws']);
      } catch (err) {
        reject(err as Error);
        return;
      }
      this.ws = ws;
      let settled = false;

      ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));

      ws.onmessage = (m) => {
        let msg: any;
        try {
          msg = JSON.parse(m.data as string);
        } catch {
          return;
        }
        this.bumpKaWatchdog();
        switch (msg.type) {
          case 'connection_ack': {
            this.kaTimeoutMs = msg.connectionTimeoutMs ?? 300_000;
            this.backoff = 500;
            const wasReconnect = this.everConnected;
            this.everConnected = true;
            this.setStatus('connected');
            // Re-establish every known subscription on the fresh socket.
            for (const [subId, sub] of this.subs) this.sendSubscribe(subId, sub);
            this.flushOutbox();
            if (!settled) {
              settled = true;
              resolve();
            }
            if (wasReconnect) for (const cb of this.reconnectListeners) cb();
            break;
          }
          case 'subscribe_success': {
            this.subs.get(msg.id)?.resolve?.();
            break;
          }
          case 'subscribe_error': {
            const sub = this.subs.get(msg.id);
            sub?.reject?.(new Error(JSON.stringify(msg.errors ?? 'subscribe_error')));
            this.subs.delete(msg.id);
            break;
          }
          case 'data': {
            const sub = this.subs.get(msg.id);
            if (!sub) break;
            // `event` may arrive as a stringified value or an array of them.
            const raw = Array.isArray(msg.event) ? msg.event : [msg.event];
            for (const item of raw) {
              try {
                sub.handler(typeof item === 'string' ? JSON.parse(item) : item);
              } catch {
                // Malformed event — skip; the next event for the subject corrects.
              }
            }
            break;
          }
          case 'publish_error':
            console.warn('[transport] publish_error', msg.errors);
            break;
          case 'ka':
          default:
            break;
        }
      };

      ws.onclose = () => this.handleDrop(settled ? undefined : reject);
      ws.onerror = () => {
        // onclose always follows; nothing to do here.
      };
    });
  }

  private bumpKaWatchdog() {
    if (this.kaTimer) clearTimeout(this.kaTimer);
    this.kaTimer = setTimeout(() => {
      // No ka within the window: the connection is silently dead.
      this.ws?.close();
    }, this.kaTimeoutMs);
  }

  private handleDrop(rejectInitial?: (e: Error) => void) {
    if (this.kaTimer) clearTimeout(this.kaTimer);
    this.ws = null;
    if (this.closedByUser) {
      this.setStatus('idle');
      return;
    }
    this.setStatus('reconnecting');
    if (rejectInitial && !this.everConnected) {
      rejectInitial(new Error('WebSocket connection failed'));
      return;
    }
    const delay = this.backoff * (1 + Math.random() * 0.5);
    this.backoff = Math.min(this.backoff * 2, 15_000);
    setTimeout(() => {
      if (!this.closedByUser) this.connect().catch(() => undefined);
    }, delay);
  }

  private sendSubscribe(subId: string, sub: PendingSub) {
    this.ws?.send(
      JSON.stringify({
        type: 'subscribe',
        id: subId,
        channel: sub.channel,
        authorization: this.authObject(),
      })
    );
  }

  subscribe(channel: string, handler: EventHandler): Promise<void> {
    const subId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const sub: PendingSub = { channel, handler, resolve, reject };
      this.subs.set(subId, sub);
      if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe(subId, sub);
      // If not open yet, connection_ack replay will pick it up.
    });
  }

  /**
   * Publish events (JS values; stringified per the protocol). Batches of ≤5.
   * While disconnected, state events queue in the outbox and flush on
   * reconnect — best effort, matching at-most-once semantics.
   */
  publish(channel: string, events: unknown[], opts: { queueOffline?: boolean } = {}): void {
    const stringified = events.map((e) => JSON.stringify(e));
    for (let i = 0; i < stringified.length; i += 5) {
      const batch = stringified.slice(i, i + 5);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'publish',
            id: crypto.randomUUID(),
            channel,
            events: batch,
            authorization: this.authObject(),
          })
        );
      } else if (opts.queueOffline) {
        this.outbox.push({ channel, events: batch });
      }
    }
  }

  private flushOutbox() {
    const queued = this.outbox;
    this.outbox = [];
    for (const { channel, events } of queued) {
      this.ws?.send(
        JSON.stringify({
          type: 'publish',
          id: crypto.randomUUID(),
          channel,
          events,
          authorization: this.authObject(),
        })
      );
    }
  }

  close(): void {
    this.closedByUser = true;
    this.subs.clear();
    this.outbox = [];
    if (this.kaTimer) clearTimeout(this.kaTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('idle');
  }
}
