/**
 * Client game-logic regression tests: the store's event application (seq
 * guards, epochs, Z-6 hidden integration) and the action layer's hidden-zone
 * bookkeeping, with the network mocked out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardState, PoolCard, StateEvent } from '@playmat/shared';

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
const { matRect, matSeatAt, matSlots } = await import('./view');

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

    actions.tapCards([guid], true);
    actions.setCounter(guid, '+1/+1', 3);
    actions.moveCard(guid, { zone: 'graveyard' });
    s = useGame.getState();
    expect(s.cards[guid]).toMatchObject({ zone: 'graveyard', tapped: false, counters: {}, order: 1 });
  });

  it('opening hand shrinks by one after playing a drawn card', () => {
    actions.drawCards(3); // 7 opening + 3 = 10
    const guid = useGame.getState().hidden.hand[0];
    actions.playFromHand(guid, 500, 600);
    expect(useGame.getState().hidden.hand).toHaveLength(9);
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

  /** A card event the foe publishes about one of MY cards (teaching mode). */
  const foeMoves = (guid: string, patch: Partial<CardState>): StateEvent => ({
    t: 'card', g: useGame.getState().room!.gameId, by: FOE, seq: 90,
    card: {
      guid, zone: 'graveyard', ownerId: ME, controllerId: ME, x: 0, y: 0,
      tapped: false, faceDown: false, faceIndex: 0, rotIndex: 0, counters: {}, order: 1,
      ...patch,
    },
  });

  it('teaching mode: a peer discarding from my hand drops it from my hand', () => {
    actions.drawCards(1);
    const guid = useGame.getState().hidden.hand[0];
    const before = useGame.getState().hidden.hand.length;
    useGame.getState().applyStateEvent(foeMoves(guid, { zone: 'graveyard' }));
    const s = useGame.getState();
    expect(s.hidden.hand).not.toContain(guid);
    expect(s.hidden.hand).toHaveLength(before - 1);
  });

  it('teaching mode: a peer tucking my hand card lands it in my library exactly once', () => {
    actions.drawCards(1);
    const guid = useGame.getState().hidden.hand[0];
    const libBefore = useGame.getState().hidden.library.length;
    useGame.getState().applyStateEvent(
      foeMoves(guid, { zone: 'library', zoneOwnerId: ME, libPos: 'top' })
    );
    const s = useGame.getState();
    // hidden -> hidden is the case a naive remove/insert pair gets wrong: the
    // insert bails because the guid is still in `hand`, so the card doubles.
    expect(s.hidden.hand).not.toContain(guid);
    expect(s.hidden.library.filter((g) => g === guid)).toHaveLength(1);
    expect(s.hidden.library).toHaveLength(libBefore + 1);
    expect(s.hidden.library[0]).toBe(guid);
  });

  it('a card may only be placed in its own owner\'s non-battlefield zones', () => {
    const guid = useGame.getState().hidden.library[0];
    expect(actions.canPlaceIn(guid, 'graveyard', ME)).toBe(true);
    expect(actions.canPlaceIn(guid, 'graveyard', FOE)).toBe(false);
    expect(actions.canPlaceIn(guid, 'library', FOE)).toBe(false);
    expect(actions.canPlaceIn(guid, 'hand', FOE)).toBe(false);
    // The battlefield is exempt: you may control an opponent's permanent.
    expect(actions.canPlaceIn(guid, 'battlefield', FOE)).toBe(true);
  });

  it('publishes my library order so peers can browse it, but never my hand', () => {
    actions.drawCards(1);
    const s = useGame.getState();
    const mine = s.playerStates[ME];
    expect(mine.library).toEqual(s.hidden.library);
    expect(mine.libraryCount).toBe(s.hidden.library.length);
    // The hand ships as a count only — no card identities.
    expect(mine.handCount).toBe(s.hidden.hand.length);
    expect(mine).not.toHaveProperty('hand');
  });

  it('a peer pulling from my library drops it from my hidden order', () => {
    const top = useGame.getState().hidden.library[0];
    const before = useGame.getState().hidden.library.length;
    useGame.getState().applyStateEvent(foeMoves(top, { zone: 'graveyard' }));
    const s = useGame.getState();
    expect(s.hidden.library).not.toContain(top);
    expect(s.hidden.library).toHaveLength(before - 1);
  });

  it('moving a peer-owned card sends it to THEIR zone, never mine', () => {
    useGame.setState({
      pool: { ...useGame.getState().pool, foecard: { guid: 'foecard', ownerId: FOE } },
    });
    actions.moveCard('foecard', { zone: 'graveyard' });
    const s = useGame.getState();
    const c = s.cards['foecard'];
    expect(c.zone).toBe('graveyard');
    expect(c.zoneOwnerId ?? c.ownerId).toBe(FOE);
    expect(s.hidden.hand).not.toContain('foecard');
    expect(s.hidden.library).not.toContain('foecard');
  });
});

describe('game state', () => {
  beforeEach(() => actions.importDeck(mkPool(10)));

  it('take turn claims the marker; the count bumps only when it changes hands', () => {
    actions.takeTurn();
    let s = useGame.getState();
    expect(s.room?.turnPlayerId).toBe(ME);
    expect(s.room?.turn).toBe(1);
    // Re-taking your own turn (double click) is the same turn — no double count.
    actions.takeTurn();
    expect(useGame.getState().room?.turn).toBe(1);
    // Free-for-all: a peer just takes the next turn (there is no pass step).
    s = useGame.getState();
    s.applyStateEvent({
      t: 'room', g: s.room!.gameId, by: FOE, seq: s.seqs['room'].seq + 1,
      room: { gameId: s.room!.gameId, turnPlayerId: FOE, turn: (s.room!.turn ?? 0) + 1 },
    });
    expect(useGame.getState().room?.turn).toBe(2);
    // Taking it back is a fresh turn again.
    actions.takeTurn();
    s = useGame.getState();
    expect(s.room?.turnPlayerId).toBe(ME);
    expect(s.room?.turn).toBe(3);
  });

  it('lands slot into the edge row, spells into the center row, taken slots skip', () => {
    const land: PoolCard = {
      guid: 'land1', ownerId: ME,
      sf: { id: 'l', name: 'Swamp', layout: 'normal', faces: [{ name: 'Swamp', img: '', type: 'Basic Land — Swamp' }] },
    };
    const land2: PoolCard = { ...land, guid: 'land2' };
    const spell: PoolCard = {
      guid: 'spell1', ownerId: ME,
      sf: { id: 's', name: 'Bear', layout: 'normal', faces: [{ name: 'Bear', img: '', type: 'Creature — Bear' }] },
    };
    useGame.setState((s) => ({ pool: { ...s.pool, land1: land, land2, spell1: spell } }));
    const p1 = actions.autoPlayPosition('land1');
    actions.moveCard('land1', { zone: 'battlefield', ...p1 });
    const p2 = actions.autoPlayPosition('land2');
    const ps = actions.autoPlayPosition('spell1');
    // Same row, different slot for the second land; different row for the spell.
    expect(p2).not.toEqual(p1);
    expect(ps.x === p1.x && ps.y === p1.y).toBe(false);
    const seatDepth = (p: { x: number; y: number }) => Math.hypot(p.x - 1200, p.y - 1200);
    // Lands sit farther from the table center (closer to the owner's edge).
    expect(seatDepth(p1)).toBeGreaterThan(seatDepth(ps));
  });

  it('mats never overlap and never cover the DMZ, for any seat occupancy', () => {
    for (let mask = 1; mask < 16; mask++) {
      const seats = [0, 1, 2, 3].filter((s) => mask & (1 << s));
      const rects = seats.map((s) => matRect(s, (q) => seats.includes(q)));
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
          expect(overlap, `seats ${seats.join(',')}: mats ${seats[i]} and ${seats[j]} overlap`).toBe(false);
        }
      }
      // The table center stays neutral ground.
      expect(matSeatAt(1200, 1200, seats)).toBeNull();
      // Every mat is big enough for its two slot rows.
      for (const s of seats) {
        expect(matSlots(s, matRect(s, (q) => seats.includes(q)), 0).length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('dropping a card on a mat claims control for that mat\'s player; the DMZ does not', () => {
    const guid = useGame.getState().hidden.library[0];
    const seats = [0, 1];
    // Deep inside FOE's (seat 1) mat:
    const foeSpot = matSlots(1, matRect(1, (q) => seats.includes(q)), 1)[0];
    actions.moveCard(guid, { zone: 'battlefield', x: foeSpot.x, y: foeSpot.y });
    expect(useGame.getState().cards[guid].controllerId).toBe(FOE);
    // Dragging to the DMZ keeps the current controller…
    actions.moveCardsGroup([{ guid, x: 1200, y: 1200 }]);
    expect(useGame.getState().cards[guid].controllerId).toBe(FOE);
    // …and onto my own mat takes it back (with a log line).
    const mySpot = matSlots(0, matRect(0, (q) => seats.includes(q)), 1)[0];
    actions.moveCardsGroup([{ guid, x: mySpot.x, y: mySpot.y }]);
    expect(useGame.getState().cards[guid].controllerId).toBe(ME);
    expect(useGame.getState().log.some((l) => /now controls/.test(l.text))).toBe(true);
    // Leaving the battlefield resets control to the owner.
    actions.moveCard(guid, { zone: 'graveyard' });
    expect(useGame.getState().cards[guid].controllerId).toBe(ME);
  });

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
