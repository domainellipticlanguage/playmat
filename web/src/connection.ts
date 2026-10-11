/**
 * Session lifecycle: join/create over HTTP, connect the events client,
 * subscribe, snapshot, reconnect handling (E-6: refetch, never replay),
 * presence heartbeat, and debounced hidden-state persistence.
 */
import {
  type HiddenState,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type SnapshotResponse,
  type StateEvent,
  type EphemeralEvent,
  ephemeralChannel,
  stateChannel,
} from '@playmat/shared';
import { config } from './config';
import { logWire } from './debug';
import { EventsClient } from './transport';
import { persisted, type StoredSession } from './session';
import { useGame } from './store';
import { useUI } from './uiStore';

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
  extra?: Omit<JoinRoomRequest, 'name'>
): Promise<JoinRoomResponse> {
  return api<JoinRoomResponse>(`/rooms/${code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name, ...extra }),
  });
}

/** A link that drops whoever opens it into `playerId`'s seat (seat recovery). */
export function takeOverLink(roomCode: string, playerId: string): string {
  return `${location.origin}${location.pathname}?room=${roomCode}&takeover=${playerId}`;
}

/**
 * Seat recovery: become `targetPlayerId` in `roomCode` — their deck, hand,
 * library, and board all live server-side under that id, so this picks up
 * exactly where they left off. If my current seat in that room is empty (no
 * cards — e.g. I rejoined as a "new player" by mistake), it's freed rather
 * than left behind as a ghost seat; a seat with a deck is kept so I can take
 * it back the same way.
 */
export async function takeOverSeat(roomCode: string, targetPlayerId: string): Promise<void> {
  const live = useGame.getState().session;
  const cur = live ?? persisted.get().lastSession;
  const savedName = persisted.get().name;
  let release: JoinRoomRequest['release'];
  if (cur && cur.roomCode === roomCode && cur.seat !== null && cur.playerId !== targetPlayerId) {
    let ownsCards = true;
    if (live) {
      flushHidden();
      ownsCards = Object.values(useGame.getState().pool).some((p) => p.ownerId === cur.playerId);
    } else {
      ownsCards = await fetchSnapshot(cur)
        .then((snap) => snap.pools.some((p) => p.ownerId === cur.playerId))
        .catch(() => true);
    }
    if (!ownsCards) release = { playerId: cur.playerId, rejoinKey: cur.rejoinKey };
  }
  const resp = await joinRoom(roomCode, savedName ?? cur?.name ?? 'Someone', { takeOver: targetPlayerId, release });
  const seatName = resp.players.find((p) => p.playerId === resp.playerId)?.name ?? savedName ?? 'Player';
  await startSession({
    roomCode: resp.roomCode,
    playerId: resp.playerId,
    seat: resp.seat,
    token: resp.token,
    rejoinKey: resp.rejoinKey,
    name: seatName,
  });
  // At the table I'm them; my lobby default name stays mine.
  if (savedName) persisted.patch({ name: savedName });
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
  persisted.saveHidden(session.roomCode, session.playerId, payload);
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
  logWire('send', 'state', events);
  if (client && code) client.publish(stateChannel(code), events, { queueOffline: true });
}

export function sendEphemeral(ev: EphemeralEvent): void {
  const code = useGame.getState().session?.roomCode;
  logWire('send', 'ephemeral', [ev]);
  if (client && code) client.publish(ephemeralChannel(code), [ev]);
}

export async function startSession(session: StoredSession): Promise<void> {
  stopSession();
  // Undo entries republish states as whoever recorded them — never carry
  // them into a different seat.
  void import('./actions').then((a) => a.clearUndo());
  // Fresh room, fresh state — nothing may bleed over from a previous session.
  useGame.setState({
    synced: false,
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
  const localHidden = persisted.getHidden(session.roomCode, session.playerId);
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
    client.subscribe(stateChannel(session.roomCode), (ev) => {
      logWire('recv', 'state', [ev]);
      useGame.getState().applyStateEvent(ev as StateEvent);
    }),
    client.subscribe(ephemeralChannel(session.roomCode), (ev) => {
      logWire('recv', 'ephemeral', [ev]);
      const e = ev as EphemeralEvent;
      if (e.t === 'peekRequest' || e.t === 'handPeek') {
        handlePeek(e);
        return;
      }
      useGame.getState().applyEphemeral(e);
    }),
  ]);

  const snap = await fetchSnapshot(session);
  useGame.getState().applySnapshot(snap);
  adoptExistingSetup();

  // Publish identity (color/playmat ride on PlayerState) right away: until
  // the first publish, everyone renders seat-default colors, so a player with
  // a saved color pick would visibly change color on their first action.
  if (session.seat !== null) {
    queueMicrotask(() => {
      void import('./actions').then((a) => a.publishMyCounts());
    });
  }

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
      // My hidden zones can also change without me acting: in teaching mode
      // another player may discard from my hand, and the store folds that in.
      // Republish the counts when they've drifted so peers don't show a stale
      // hand size. My own actions already publish correct counts, so this is a
      // no-op for them.
      const me = s.session?.playerId;
      const mine = me ? s.playerStates[me] : undefined;
      if (
        mine &&
        (mine.handCount !== s.hidden.hand.length || mine.libraryCount !== s.hidden.library.length)
      ) {
        queueMicrotask(() => {
          void import('./actions').then((a) => a.publishMyCounts());
        });
      }
    }
    // A peer opened or closed my hand (Duress, Gitaxian Probe…): only this
    // client knows what's in it, so answer with the reveals. Cards arriving in
    // an open hand (draws, a peer's bounce) get revealed the same way.
    {
      const me = s.session?.playerId;
      const open = me ? s.playerStates[me]?.showHandToTable : undefined;
      const was = me ? prev.playerStates[me]?.showHandToTable : undefined;
      const flippedByPeer = open !== was && s.seqs[`player#${me}`]?.by !== me;
      if (me && (flippedByPeer || (open && s.hiddenSeq !== prev.hiddenSeq))) {
        queueMicrotask(() => {
          void import('./actions').then((a) => a.syncOpenHand(!!useGame.getState().playerStates[me]?.showHandToTable));
        });
      }
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

/** Ask `target`'s client to show me their hand (only me). */
export function requestHandPeek(target: string): void {
  const me = useGame.getState().session?.playerId;
  if (me) sendEphemeral({ t: 'peekRequest', by: me, target, ts: Date.now() });
}

function handlePeek(e: Extract<EphemeralEvent, { t: 'peekRequest' } | { t: 'handPeek' }>): void {
  const s = useGame.getState();
  const me = s.session?.playerId;
  if (!me) return;
  if (e.t === 'peekRequest' && e.target === me) {
    // I'm the only one who knows my hand: answer the asker directly.
    sendEphemeral({ t: 'handPeek', by: me, to: e.by, hand: s.hidden.hand, ts: Date.now() });
  } else if (e.t === 'handPeek' && e.to === me) {
    useUI.getState().openModal({ kind: 'handPeek', ownerId: e.by, hand: e.hand });
  }
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
