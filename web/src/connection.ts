/**
 * Session lifecycle: join/create over HTTP, connect the events client,
 * subscribe, snapshot, reconnect handling (E-6: refetch, never replay),
 * presence heartbeat, and debounced hidden-state persistence.
 */
import {
  type HiddenState,
  type JoinRoomResponse,
  type SnapshotResponse,
  type StateEvent,
  type EphemeralEvent,
  ephemeralChannel,
  stateChannel,
} from '@playmat/shared';
import { config } from './config';
import { EventsClient } from './transport';
import { persisted, type StoredSession } from './session';
import { useGame } from './store';

let client: EventsClient | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let hiddenDebounce: ReturnType<typeof setTimeout> | null = null;
let storeUnsub: (() => void) | null = null;
let lastPersistedHiddenSeq = -1;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.apiBase}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function createRoom(name: string): Promise<JoinRoomResponse> {
  return api<JoinRoomResponse>('/rooms', { method: 'POST', body: JSON.stringify({ name }) });
}

export async function joinRoom(
  code: string,
  name: string,
  rejoin?: { playerId: string; rejoinKey: string }
): Promise<JoinRoomResponse> {
  return api<JoinRoomResponse>(`/rooms/${code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name, ...rejoin }),
  });
}

async function fetchSnapshot(session: StoredSession): Promise<SnapshotResponse> {
  return api<SnapshotResponse>(`/rooms/${session.roomCode}/snapshot`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
}

function persistHiddenNow(session: StoredSession): void {
  const { hidden, hiddenSeq, room } = useGame.getState();
  if (hiddenSeq === lastPersistedHiddenSeq) return;
  lastPersistedHiddenSeq = hiddenSeq;
  const payload: HiddenState = {
    gameId: room?.gameId ?? '',
    seq: hiddenSeq,
    library: hidden.library,
    hand: hidden.hand,
  };
  persisted.saveHidden(session.roomCode, payload);
  void api(`/rooms/${session.roomCode}/hidden`, {
    method: 'PUT',
    body: JSON.stringify(payload),
    headers: { Authorization: `Bearer ${session.token}` },
  }).catch(() => {
    // Retry on the next change; localStorage already has it.
    lastPersistedHiddenSeq = -1;
  });
}

/** Publish committed state events: optimistic local apply + fan out. */
export function sendState(events: StateEvent[]): void {
  const store = useGame.getState();
  for (const ev of events) store.applyStateEvent(ev);
  const code = store.session?.roomCode;
  if (client && code) client.publish(stateChannel(code), events, { queueOffline: true });
}

export function sendEphemeral(ev: EphemeralEvent): void {
  const code = useGame.getState().session?.roomCode;
  if (client && code) client.publish(ephemeralChannel(code), [ev]);
}

export async function startSession(session: StoredSession): Promise<void> {
  stopSession();
  // Fresh room, fresh state — nothing may bleed over from a previous session.
  useGame.setState({
    players: [],
    playerStates: {},
    room: null,
    pool: {},
    cards: {},
    seqs: {},
    poolImports: {},
    hidden: { library: [], hand: [] },
    hiddenSeq: 0,
    log: [],
    cursors: {},
    drags: {},
    presence: {},
    selection: [],
    setupGameId: null,
  });
  const store = useGame.getState();
  store.setSession(session);
  persisted.patch({ lastSession: session, name: session.name });

  // Local copy of hidden zones is available before the network is.
  const localHidden = persisted.getHidden(session.roomCode);
  if (localHidden) {
    useGame.setState({
      hidden: { library: localHidden.library, hand: localHidden.hand },
      hiddenSeq: localHidden.seq,
    });
    lastPersistedHiddenSeq = localHidden.seq;
  }

  client = new EventsClient(session.token);
  client.onStatus((s) => useGame.getState().setConnStatus(s));

  await client.connect();

  // Subscribe FIRST, then snapshot: events landing in between are also in the
  // snapshot (persisted before broadcast) and the seq guard dedupes (R-5).
  await Promise.all([
    client.subscribe(stateChannel(session.roomCode), (ev) =>
      useGame.getState().applyStateEvent(ev as StateEvent)
    ),
    client.subscribe(ephemeralChannel(session.roomCode), (ev) =>
      useGame.getState().applyEphemeral(ev as EphemeralEvent)
    ),
  ]);

  const snap = await fetchSnapshot(session);
  useGame.getState().applySnapshot(snap);
  adoptExistingSetup();

  client.onReconnected(() => {
    void fetchSnapshot(session)
      .then((s) => {
        useGame.getState().applySnapshot(s);
        adoptExistingSetup();
      })
      .catch(() => undefined);
  });

  // Presence heartbeat + ephemeral pruning.
  presenceTimer = setInterval(() => {
    sendEphemeral({
      t: 'presence',
      by: session.playerId,
      name: session.name,
      seat: session.seat,
      ts: Date.now(),
    });
  }, 10_000);
  pruneTimer = setInterval(() => useGame.getState().pruneEphemeral(), 2_000);

  // Persist hidden zones (debounced) whenever they change, and run my
  // per-game setup when the game epoch changes (peer reset / new game).
  storeUnsub = useGame.subscribe((s, prev) => {
    if (s.hiddenSeq !== prev.hiddenSeq) {
      if (hiddenDebounce) clearTimeout(hiddenDebounce);
      hiddenDebounce = setTimeout(() => persistHiddenNow(session), 600);
    }
    const gid = s.room?.gameId;
    if (gid && gid !== prev.room?.gameId) {
      // Microtask: let the current event batch finish applying first.
      queueMicrotask(() => {
        void import('./actions').then((a) => a.runNewGameSetup(gid));
      });
    }
  });
}

/**
 * After a snapshot: if the current game already has my hidden state or board
 * presence, mark setup done so we don't re-shuffle on top of a live game.
 */
function adoptExistingSetup(): void {
  const s = useGame.getState();
  const gameId = s.room?.gameId;
  const me = s.session?.playerId;
  if (!gameId || !me) return;
  const hasHidden = s.hidden.library.length + s.hidden.hand.length > 0;
  const hasBoard = Object.values(s.cards).some((c) => c.ownerId === me);
  const hasPlayerState = !!s.playerStates[me];
  if (hasHidden || hasBoard || hasPlayerState) s.markSetupDone(gameId);
}

export function stopSession(): void {
  if (presenceTimer) clearInterval(presenceTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  if (hiddenDebounce) clearTimeout(hiddenDebounce);
  presenceTimer = pruneTimer = hiddenDebounce = null;
  storeUnsub?.();
  storeUnsub = null;
  lastPersistedHiddenSeq = -1;
  client?.close();
  client = null;
}

export function flushHidden(): void {
  const session = useGame.getState().session;
  if (session) persistHiddenNow(session);
}
