/**
 * Client game-logic regression tests: the store's event application (seq
 * guards, epochs, Z-6 hidden integration) and the action layer's hidden-zone
 * bookkeeping, with the network mocked out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolCard, StateEvent } from '@playmat/shared';

// Capture published events; apply them optimistically exactly like the real
// sendState does, so actions behave as in the browser.
const published: StateEvent[] = [];
vi.mock('./connection', () => ({
  sendState: (events: StateEvent[]) => {
    published.push(...events);
    for (const ev of events) useGame.getState().applyStateEvent(ev);
  },
  sendEphemeral: () => undefined,
  flushHidden: () => undefined,
}));

const { useGame } = await import('./store');
const actions = await import('./actions');

const ME = 'me-player';
const FOE = 'foe-player';

function seedSession() {
  useGame.setState({
    session: { roomCode: 'ROOM1', playerId: ME, seat: 0, token: 't', rejoinKey: 'r', name: 'Me' },
    players: [
      { playerId: ME, seat: 0, name: 'Me', joinedAt: 1 },
      { playerId: FOE, seat: 1, name: 'Foe', joinedAt: 2 },
    ],
    playerStates: {},
    room: null,
    pool: {},
    cards: {},
    seqs: {},
    poolImports: {},
    hidden: { library: [], hand: [] },
    hiddenSeq: 0,
    log: [],
    selection: [],
    setupGameId: null,
  });
}

function mkPool(n: number, opts: Partial<PoolCard> = {}): PoolCard[] {
  return Array.from({ length: n }, (_, i) => ({
    guid: `c${i}`,
    ownerId: ME,
    sf: { id: `sf${i}`, name: `Card ${i}`, layout: 'normal', faces: [{ name: `Card ${i}`, img: 'x' }] },
    ...opts,
  }));
}

beforeEach(() => {
  published.length = 0;
  seedSession();
});

describe('seq guards', () => {
  const cardEv = (seq: number, by: string, x: number): StateEvent => ({
    t: 'card', g: 'g1', by, seq,
    card: { guid: 'k', zone: 'battlefield', ownerId: FOE, controllerId: FOE, x, y: 0, tapped: false, faceDown: false, faceIndex: 0, rotIndex: 0, counters: {}, order: 0 },
  });

  it('discards stale and equal seqs, applies newer', () => {
    const s = useGame.getState();
    s.applyStateEvent(cardEv(2, FOE, 100));
    expect(useGame.getState().cards['k'].x).toBe(100);
    useGame.getState().applyStateEvent(cardEv(1, FOE, 50));
    expect(useGame.getState().cards['k'].x).toBe(100); // stale dropped
    useGame.getState().applyStateEvent(cardEv(2, FOE, 60));
    expect(useGame.getState().cards['k'].x).toBe(100); // equal dropped
    useGame.getState().applyStateEvent(cardEv(3, FOE, 70));
    expect(useGame.getState().cards['k'].x).toBe(70);
  });

  it('breaks seq ties deterministically by publisher id', () => {
    useGame.getState().applyStateEvent(cardEv(5, 'aaa', 1));
    useGame.getState().applyStateEvent(cardEv(5, 'zzz', 2));
    expect(useGame.getState().cards['k'].x).toBe(2); // zzz > aaa wins
    useGame.getState().applyStateEvent(cardEv(5, 'mmm', 3));
    expect(useGame.getState().cards['k'].x).toBe(2); // mmm < zzz dropped
  });
});

describe('deck import + setup', () => {
  it('imports 100 cards, commanders to command zone, opening 7 dealt', () => {
    const pool = mkPool(100);
    pool[0].commander = true;
    actions.importDeck(pool);
    const s = useGame.getState();
    expect(Object.keys(s.pool)).toHaveLength(100);
    expect(s.hidden.library).toHaveLength(92);
    expect(s.hidden.hand).toHaveLength(7);
    expect(s.hidden.library).not.toContain('c0');
    expect(s.hidden.hand).not.toContain('c0');
    expect(s.cards['c0']?.zone).toBe('command');
    expect(s.playerStates[ME].life).toBe(40);
    expect(s.playerStates[ME].libraryCount).toBe(92);
    expect(s.playerStates[ME].handCount).toBe(7);
    expect(s.room?.gameId).toBeTruthy();
    expect(s.setupGameId).toBe(s.room?.gameId);
  });

  it('re-import replaces the pool entirely (importId epoch)', () => {
    actions.importDeck(mkPool(10));
    const g1 = useGame.getState().room?.gameId;
    actions.importDeck(mkPool(5).map((c) => ({ ...c, guid: `n${c.guid}` })));
    const s = useGame.getState();
    expect(s.room?.gameId).not.toBe(g1); // re-import bumps the game
    const mine = Object.values(s.pool).filter((p) => p.ownerId === ME);
    expect(mine.map((p) => p.guid).sort()).toEqual(['nc0', 'nc1', 'nc2', 'nc3', 'nc4']);
    // 5-card deck: all 5 dealt into the opening hand, library empty.
    expect(s.hidden.hand).toHaveLength(5);
    expect(s.hidden.library).toHaveLength(0);
  });

  it('mulligan shuffles the hand back and draws 7 again', () => {
    actions.importDeck(mkPool(20)); // 13 library / 7 hand
    const before = useGame.getState();
    const all = [...before.hidden.library, ...before.hidden.hand].sort();
    actions.mulligan();
    const s = useGame.getState();
    expect(s.hidden.hand).toHaveLength(7);
    expect(s.hidden.library).toHaveLength(13);
    expect([...s.hidden.library, ...s.hidden.hand].sort()).toEqual(all);
    expect(s.playerStates[ME].handCount).toBe(7);
    expect(s.playerStates[ME].libraryCount).toBe(13);
  });

  it('stale pool chunks from an older import are ignored', () => {
    actions.importDeck(mkPool(3));
    const s = useGame.getState();
    const g = s.room!.gameId;
    // A straggler chunk from an older (lexicographically smaller) import:
    s.applyStateEvent({
      t: 'pool', g, by: ME, seq: 99, chunk: 7, nChunks: 8, importId: '0000-old',
      cards: [{ guid: 'ghost', ownerId: ME, sf: { id: 'x', name: 'Ghost', layout: 'normal', faces: [] } }],
    });
    expect(useGame.getState().pool['ghost']).toBeUndefined();
  });
});

describe('hidden-zone bookkeeping', () => {
  beforeEach(() => actions.importDeck(mkPool(20)));

  it('draw moves top cards to hand and publishes counts only', () => {
    const st0 = useGame.getState();
    const openingHand = st0.hidden.hand; // 7 dealt at setup
    const top = st0.hidden.library.slice(0, 3);
    published.length = 0;
    actions.drawCards(3);
    const s = useGame.getState();
    expect(s.hidden.hand).toEqual([...openingHand, ...top]);
    expect(s.hidden.library).toHaveLength(10);
    expect(s.playerStates[ME].handCount).toBe(10);
    // No card identities leak: only player + log events.
    expect(published.filter((e) => e.t === 'card')).toHaveLength(0);
  });

  it('play from hand publishes the card; discard clears battlefield state', () => {
    actions.drawCards(3);
    const guid = useGame.getState().hidden.hand[0];
    actions.playFromHand(guid, 500, 600);
    let s = useGame.getState();
    expect(s.cards[guid]).toMatchObject({ zone: 'battlefield', x: 500, y: 600 });
    expect(s.hidden.hand).toHaveLength(2);

    actions.tapCards([guid], true);
    actions.setCounter(guid, '+1/+1', 3);
    actions.moveCard(guid, { zone: 'graveyard' });
    s = useGame.getState();
    expect(s.cards[guid]).toMatchObject({ zone: 'graveyard', tapped: false, counters: {}, order: 1 });
  });

  it('tuck to library bottom returns the card to hidden order', () => {
    actions.drawCards(1);
    const guid = useGame.getState().hidden.hand[0];
    actions.playFromHand(guid, 0, 0);
    actions.moveCard(guid, { zone: 'library', libPos: 'bottom' });
    const s = useGame.getState();
    expect(s.hidden.library[s.hidden.library.length - 1]).toBe(guid);
    expect(s.cards[guid]?.zone).toBe('library'); // removal marker for peers
  });

  it('Z-6: a peer putting a card into MY library integrates at the hinted spot', () => {
    const libBefore = useGame.getState().hidden.library.slice();
    useGame.getState().applyStateEvent({
      t: 'card', g: useGame.getState().room!.gameId, by: FOE, seq: 50,
      card: { guid: 'gift', zone: 'library', ownerId: FOE, controllerId: FOE, zoneOwnerId: ME, libPos: 'top', x: 0, y: 0, tapped: false, faceDown: false, faceIndex: 0, rotIndex: 0, counters: {}, order: 0 },
    });
    const s = useGame.getState();
    expect(s.hidden.library[0]).toBe('gift');
    expect(s.hidden.library).toHaveLength(libBefore.length + 1);
  });
});

describe('game state', () => {
  beforeEach(() => actions.importDeck(mkPool(10)));

  it('commander damage ticks life in the same event', () => {
    const cmdrGuid = 'enemy-cmdr';
    useGame.setState((s) => ({
      pool: { ...s.pool, [cmdrGuid]: { guid: cmdrGuid, ownerId: FOE, commander: true, sf: { id: 'e', name: 'Enemy', layout: 'normal', faces: [] } } },
    }));
    actions.dealCommanderDamage(ME, cmdrGuid, 3);
    const ps = useGame.getState().playerStates[ME];
    expect(ps.commanderDamage[cmdrGuid]).toBe(3);
    expect(ps.life).toBe(37);
    actions.dealCommanderDamage(ME, cmdrGuid, -1);
    const ps2 = useGame.getState().playerStates[ME];
    expect(ps2.commanderDamage[cmdrGuid]).toBe(2);
    expect(ps2.life).toBe(38);
  });

  it('new game purges the board and reruns setup with the same deck', () => {
    actions.drawCards(3);
    const guid = useGame.getState().hidden.hand[0];
    actions.playFromHand(guid, 1, 2);
    const g1 = useGame.getState().room!.gameId;

    actions.resetGame();
    const s = useGame.getState();
    expect(s.room!.gameId).not.toBe(g1);
    // Board purged by the epoch change...
    expect(Object.values(s.cards).filter((c) => c.zone === 'battlefield')).toHaveLength(0);
    // ...and per-client setup is the connection layer's job (guarded by setupGameId).
    expect(s.setupGameId).toBe(g1); // not yet re-run here (no connection layer in test)
    actions.runNewGameSetup(s.room!.gameId);
    const s2 = useGame.getState();
    expect(s2.hidden.library).toHaveLength(3);
    expect(s2.hidden.hand).toHaveLength(7);
    expect(s2.playerStates[ME].life).toBe(40);
  });
});
