import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PlayerState, PoolCard, SeatRecord, ZoneName } from '@playmat/shared';
import { useGame } from '../store';
import { useUI } from '../uiStore';
import * as actions from '../actions';
import { liveView, relativeEdge, screenToWorld } from '../view';
import { paletteColor } from '../colors';
import { CardView, DragGhost, closeCrucibleMenus } from './CardView';
import { LinkIcon } from './icons';

const PLAYER_COUNTERS = ['poison', 'energy', 'experience'];

/** Where a pile drag ended up. */
type PileDropTarget =
  | { kind: 'zone'; zone: ZoneName; zoneOwnerId?: string }
  | { kind: 'battlefield'; x: number; y: number };

type PileDropFn = (target: PileDropTarget, shiftKey: boolean) => void;

/** What the drag ghost shows: a pool card, or (empty) a face-down card back. */
type PileGhostCard = { pool?: PoolCard; rotIndex?: number };

/**
 * Drag-from-pile plumbing: piles are drag sources as well as drop targets.
 * Below the movement threshold the gesture stays a click (draw / open modal);
 * past it a ghost follows the pointer and the drop function fires on release.
 */
function usePileDrag() {
  const [ghost, setGhost] = useState<(PileGhostCard & { x: number; y: number }) | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean; card: PileGhostCard; drop: PileDropFn } | null>(null);
  const suppressClick = useRef(false);

  const start = (card: PileGhostCard, drop: PileDropFn) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    closeCrucibleMenus(); // preventDefault below suppresses the mousedown it needs
    dragRef.current = { startX: e.clientX, startY: e.clientY, moved: false, card, drop };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    // Without this the browser starts a native HTML5 image drag, fires
    // pointercancel, and our pointerup never arrives.
    e.preventDefault();
  };

  const cancel = () => {
    dragRef.current = null;
    setGhost(null);
    useUI.getState().setDragging(null);
  };

  const move = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6) {
      d.moved = true;
      // The real guid when we know it, so drop targets can gate on ownership;
      // 'pile' is the fallback sentinel (e.g. a face-down library top).
      useUI.getState().setDragging(d.card.pool?.guid ?? 'pile');
    }
    if (d.moved) setGhost({ ...d.card, x: e.clientX, y: e.clientY });
  };

  const end = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setGhost(null);
    useUI.getState().setDragging(null);
    if (!d?.moved) return; // plain click — let onClick handle it
    suppressClick.current = true;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const zoneEl = el?.closest('[data-drop]') as HTMLElement | null;
    if (zoneEl) {
      const [zone, zoneOwnerId] = zoneEl.dataset.drop!.split(':');
      d.drop({ kind: 'zone', zone: zone as ZoneName, zoneOwnerId: zoneOwnerId || undefined }, e.shiftKey);
      return;
    }
    const bf = el?.closest('.battlefield-viewport');
    if (bf) {
      const r = bf.getBoundingClientRect();
      const w = screenToWorld(liveView.current, e.clientX - r.left, e.clientY - r.top);
      d.drop({ kind: 'battlefield', x: w.x, y: w.y }, e.shiftKey);
    }
  };

  /** Wrap a pile's onClick so a completed drag doesn't also count as a click. */
  const guardClick = (onClick: () => void) => () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onClick();
  };

  return { ghost, start, move, end, cancel, guardClick };
}

export function PlayerHud({ player }: { player: SeatRecord }) {
  const session = useGame((s) => s.session);
  const ps = useGame((s) => s.playerStates[player.playerId]);
  const pool = useGame((s) => s.pool);
  const cards = useGame((s) => s.cards);
  const presence = useGame((s) => s.presence);
  const room = useGame((s) => s.room);
  const hidden = useGame((s) => s.hidden);
  const prefs = useGame((s) => s.prefs);

  const isMe = session?.playerId === player.playerId;
  const edge = relativeEdge(player.seat, session?.seat ?? null);
  const pid = player.playerId;

  const state: PlayerState = ps ?? {
    playerId: pid,
    seat: player.seat,
    name: player.name,
    life: prefs.defaultLife,
    counters: {},
    commanderDamage: {},
    handCount: 0,
    libraryCount: 0,
    topRevealed: null,
  };

  // My own row shows the REAL transport status — it's the only connectivity
  // indicator (the topbar one was redundant). Peers go by their heartbeat.
  const connStatus = useGame((s) => s.connStatus);
  const lastSeen = presence[pid] ?? 0;
  const presenceClass = isMe
    ? connStatus === 'connected'
      ? 'connected'
      : connStatus === 'connecting' || connStatus === 'reconnecting'
        ? 'away'
        : 'dead'
    : Date.now() - lastSeen < 25_000
      ? 'connected'
      : lastSeen
        ? 'away'
        : '';
  const presenceTitle = isMe
    ? connStatus === 'connecting' || connStatus === 'reconnecting'
      ? `${connStatus}…`
      : connStatus === 'connected'
        ? 'connected'
        : 'disconnected'
    : presenceClass || 'not seen yet';

  const pileDrag = usePileDrag();

  /**
   * Drag the top of a library: battlefield = play, hand = draw, graveyard = mill.
   * Works on anyone's library — my own order is local, a peer's rides along on
   * their PlayerState.
   */
  const dropFromLibrary: PileDropFn = (target, shift) => {
    const top = isMe ? useGame.getState().hidden.library[0] : state.library?.[0];
    if (!top) return;
    if (target.kind === 'battlefield') {
      actions.moveCard(top, { zone: 'battlefield', x: target.x, y: target.y, faceDown: shift });
    } else if (target.zone === 'hand' && (target.zoneOwnerId ?? pid) === pid) {
      // To the owner's own hand, this is a draw.
      if (isMe) actions.drawCards(1);
      else actions.moveCard(top, { zone: 'hand' });
    } else if (target.zone !== 'library' && actions.canPlaceIn(top, target.zone, target.zoneOwnerId)) {
      actions.moveCard(top, { zone: target.zone });
    }
  };

  /** Drag the top card of a public pile (graveyard/exile/command) anywhere. */
  const dropFromPileCard =
    (guid: string): PileDropFn =>
    (target, shift) => {
      if (target.kind === 'battlefield') {
        actions.moveCard(guid, { zone: 'battlefield', x: target.x, y: target.y, faceDown: shift });
      } else if (actions.canPlaceIn(guid, target.zone, target.zoneOwnerId)) {
        // Dropping on someone else's pile is refused, not rerouted: a card only
        // ever enters its own owner's zones.
        actions.moveCard(guid, {
          zone: target.zone,
          libPos: target.zone === 'library' ? 'top' : undefined,
        });
      }
    };

  // Zone piles: cards whose zone-owner is this player.
  const piles = useMemo(() => {
    const gy: typeof cards[string][] = [];
    const exile: typeof cards[string][] = [];
    const command: typeof cards[string][] = [];
    const revealed: typeof cards[string][] = [];
    for (const c of Object.values(cards)) {
      const zo = c.zoneOwnerId ?? c.ownerId;
      if (zo !== pid) continue;
      if (c.zone === 'graveyard') gy.push(c);
      else if (c.zone === 'exile') exile.push(c);
      else if (c.zone === 'command') command.push(c);
      else if (c.zone === 'hand' && c.revealed) revealed.push(c);
    }
    const byOrder = (a: { order: number }, b: { order: number }) => b.order - a.order;
    gy.sort(byOrder);
    exile.sort(byOrder);
    command.sort(byOrder);
    return { gy, exile, command, revealed };
  }, [cards, pid]);

  // Opposing commanders that could deal damage to this player.
  const enemyCommanders = useMemo(
    () => Object.values(pool).filter((p) => p.commander && p.ownerId !== pid),
    [pool, pid]
  );

  const libraryCount = isMe ? hidden.library.length : state.libraryCount;
  const handCount = isMe ? hidden.hand.length : state.handCount;
  const topRevealedPool = state.topRevealed ? pool[state.topRevealed] : null;

  /**
   * Right-click menus for the public piles (Archidekt parity). Browsing works
   * on anyone's; bulk operations only on your own (cards route to their
   * owner's zones anyway — this just keeps the menu honest).
   */
  const pileMenu = (zone: 'graveyard' | 'exile' | 'command') => (e: React.MouseEvent) => {
    e.preventDefault();
    const ui = useUI.getState();
    const list = zone === 'graveyard' ? piles.gy : zone === 'exile' ? piles.exile : piles.command;
    const whose = isMe ? '' : `${player.name}'s `;
    const items: NonNullable<Parameters<typeof ui.openCtxMenu>[0]>['items'] = [];
    if (zone === 'command' && isMe) {
      for (const c of list) {
        const name = pool[c.guid]?.sf?.name ?? 'commander';
        const tax = (c.counters['tax'] ?? 0) * 2;
        items.push({
          label: `Play ${name}${tax > 0 ? ` (tax +${tax})` : ''}`,
          action: () =>
            actions.moveCard(c.guid, { zone: 'battlefield', ...actions.autoPlayPosition(c.guid) }),
        });
      }
      if (list.length === 1) {
        const c = list[0];
        const tax = c.counters['tax'] ?? 0;
        items.push({
          label: `Command tax: +${tax * 2} (raise)`,
          action: () => actions.setCounter(c.guid, 'tax', tax + 1),
        });
      }
      if (items.length) items.push({ sep: true, label: '' });
    }
    items.push({
      label: `View ${whose}${zone === 'command' ? 'command zone' : zone} (${list.length})`,
      action: () => ui.openModal({ kind: 'zone', zone, zoneOwnerId: pid }),
    });
    if (zone === 'graveyard' && isMe && list.length > 0) {
      items.push({ sep: true, label: '' });
      items.push({
        label: 'Exile all',
        action: () => {
          for (const c of piles.gy) actions.moveCard(c.guid, { zone: 'exile' });
        },
      });
      items.push({
        label: 'Shuffle into library',
        action: () => {
          for (const c of piles.gy) actions.moveCard(c.guid, { zone: 'library', libPos: 'top' });
          actions.shuffleLibrary();
        },
      });
    }
    ui.openCtxMenu({ x: e.clientX, y: e.clientY, items });
  };

  const libraryMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const ui = useUI.getState();
    if (!isMe) {
      // Library order is published, so a peer's deck has the same reach as
      // their graveyard. Reordering stays with the owner: only their client
      // holds the authoritative array, so a shuffle from here wouldn't stick.
      ui.openCtxMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: `Search ${player.name}'s library`,
            action: () => ui.openModal({ kind: 'search', ownerId: pid }),
          },
          {
            label: 'Mill  (M on hover)',
            children: [
              ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
                label: `Mill ${n} card${n > 1 ? 's' : ''}`,
                action: () => actions.millTheirCards(pid, n),
              })),
              {
                label: 'Mill X cards…',
                action: () => {
                  const n = Number(prompt(`Mill how many of ${player.name}'s cards?`, '12'));
                  if (n > 0) actions.millTheirCards(pid, n);
                },
              },
            ],
          },
        ],
      });
      return;
    }
    ui.openCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Draw 1  (D)', action: () => actions.drawCards(1) },
        { label: 'Draw 7', action: () => actions.drawCards(7) },
        { label: 'Mulligan (hand back, draw 7)', action: () => actions.mulligan() },
        { label: 'Shuffle', action: () => actions.shuffleLibrary() },
        { sep: true, label: '' },
        { label: 'Scry / look at top…', action: () => {
            const n = Number(prompt('Look at how many cards?', '3'));
            if (n > 0) ui.openModal({ kind: 'peek', count: n, mode: 'scry' });
          } },
        { label: 'Search library', action: () => ui.openModal({ kind: 'search' }) },
        {
          label: 'Mill  (M)',
          children: [
            ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
              label: `Mill ${n} card${n > 1 ? 's' : ''}`,
              action: () => actions.millCards(n),
            })),
            {
              label: 'Mill X cards…',
              action: () => {
                const n = Number(prompt('Mill how many cards?', '12'));
                if (n > 0) actions.millCards(n);
              },
            },
          ],
        },
        { sep: true, label: '' },
        { label: state.topRevealed ? 'Stop playing with top revealed' : 'Play with top revealed',
          action: () => actions.setTopRevealed(!state.topRevealed) },
      ],
    });
  };

  /**
   * Teaching mode: this player opened their hand to the table, so anyone may
   * act on it. Every move below routes to THEIR zones automatically — moveCard
   * resolves the destination from the card's owner, not from who clicked.
   */
  const canActOnHand = !isMe && !!state.showHandToTable;

  const revealedHandMenu = (guid: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    useUI.getState().openCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: `Play for ${player.name}`,
          // Slots into the OWNER's rows — lands by their edge, spells centered.
          action: () => actions.moveCard(guid, { zone: 'battlefield', ...actions.autoPlayPosition(guid) }),
        },
        { sep: true, label: '' },
        { label: 'Discard', action: () => actions.moveCard(guid, { zone: 'graveyard' }) },
        { label: 'Exile', action: () => actions.moveCard(guid, { zone: 'exile' }) },
        { label: 'To library (top)', action: () => actions.moveCard(guid, { zone: 'library', libPos: 'top' }) },
        { label: 'To library (bottom)', action: () => actions.moveCard(guid, { zone: 'library', libPos: 'bottom' }) },
      ],
    });
  };

  const lifeAdjust = (delta: number) => actions.setLife(pid, state.life + delta);

  // Client-only: fold the tray down to a stat line so it stops hiding the
  // battlefield. Piles aren't drop targets while collapsed — expand to drop.
  // Phones start collapsed: an expanded tray buries half the hand strip.
  const [collapsed, setCollapsed] = useState(
    () => window.matchMedia('(max-width: 700px)').matches
  );

  if (collapsed) {
    return (
      <div
        className={`hud collapsed pos-${edge}${room?.turnPlayerId === pid ? ' turn' : ''}`}
        title="Tap to expand player tray"
        onClick={() => setCollapsed(false)}
      >
        <button className="hud-collapse" title="Expand player tray" onClick={() => setCollapsed(false)}>
          ▸
        </button>
        <div className="hud-mini">
          <span className={`presence ${presenceClass}`} title={presenceTitle}>
            <LinkIcon slashed={presenceClass !== 'connected'} size={12} />
          </span>
          <span className="player-chip" style={{ background: paletteColor(state.color, player.seat).hex }} />
          <b>{player.name}</b>
          {room?.turnPlayerId === pid && <span className="turn-badge">▶ turn</span>}
          <span className="mini-stat" title="life">♥ {state.life}</span>
          <span className="mini-stat" title="cards in hand">✋ {handCount}</span>
          <span className="mini-stat" title="cards in library">🂠 {libraryCount}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`hud pos-${edge}${room?.turnPlayerId === pid ? ' turn' : ''}`}>
      <button className="hud-collapse" title="Collapse player tray" onClick={() => setCollapsed(true)}>
        ▾
      </button>
      <div className="who">
        <div className="name">
          <span className={`presence ${presenceClass}`} title={presenceTitle}>
            <LinkIcon slashed={presenceClass !== 'connected'} size={12} />
          </span>
          <span
            className="player-chip"
            title={`${player.name}'s color — their playmat and card rings`}
            style={{ background: paletteColor(state.color, player.seat).hex }}
          />
          {player.name} {isMe && <span style={{ color: 'var(--ink-dim)' }}>(you)</span>}
          {room?.turnPlayerId === pid && (
            <span className="turn-badge" title={isMe ? 'Your turn' : `${player.name}'s turn`}>
              ▶ turn
            </span>
          )}
        </div>
        <div className="life">
          <div className="stack">
            <button className="small" onClick={() => lifeAdjust(1)}>+1</button>
            <button className="small" onClick={() => lifeAdjust(5)}>+5</button>
          </div>
          <div
            className="total"
            title="Click to set exactly"
            onClick={() => {
              const v = Number(prompt(`${player.name}'s life:`, String(state.life)));
              if (Number.isFinite(v)) actions.setLife(pid, v);
            }}
          >
            {state.life}
          </div>
          <div className="stack">
            <button className="small" onClick={() => lifeAdjust(-1)}>−1</button>
            <button className="small" onClick={() => lifeAdjust(-5)}>−5</button>
          </div>
        </div>
        <div className="pcounters">
          {PLAYER_COUNTERS.map((name) => {
            const v = state.counters[name] ?? 0;
            if (!v && name !== 'poison') return null;
            return (
              <span
                key={name}
                className="pcounter"
                title={`${name}: click +1, right-click −1`}
                onClick={() => actions.setPlayerCounter(pid, name, v + 1)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  actions.setPlayerCounter(pid, name, v - 1);
                }}
              >
                {name === 'poison' ? '☠' : name === 'energy' ? '⚡' : '★'} {v}
              </span>
            );
          })}
          <span
            className="pcounter"
            title="Add energy/experience"
            onClick={(e) => {
              e.preventDefault();
              useUI.getState().openCtxMenu({
                x: e.clientX, y: e.clientY,
                items: PLAYER_COUNTERS.map((name) => ({
                  label: `+1 ${name}`,
                  action: () => actions.setPlayerCounter(pid, name, (state.counters[name] ?? 0) + 1),
                })),
              });
            }}
          >
            +
          </span>
        </div>
        {enemyCommanders.length > 0 && (
          <div className="cmdr-dmg">
            {enemyCommanders.map((cmdr) => {
              const dmg = state.commanderDamage[cmdr.guid] ?? 0;
              const label = cmdr.sf?.name?.split(',')[0] ?? 'Commander';
              return (
                <div key={cmdr.guid} className="row" title={`Commander damage from ${cmdr.sf?.name} (ticks life too)`}>
                  <button className="small" onClick={() => actions.dealCommanderDamage(pid, cmdr.guid, -1)}>−</button>
                  <span style={{ minWidth: 18, textAlign: 'center', fontWeight: dmg >= 21 ? 'bold' : undefined, color: dmg >= 21 ? 'var(--danger)' : undefined }}>{dmg}</span>
                  <button className="small" onClick={() => actions.dealCommanderDamage(pid, cmdr.guid, 1)}>+</button>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 90 }}>{label}</span>
                </div>
              );
            })}
          </div>
        )}
        {piles.revealed.length > 0 && (
          <div
            className={`revealed-strip${canActOnHand ? ' actionable' : ''}`}
            title={
              canActOnHand
                ? `${player.name} is showing their hand — right-click a card to act on it`
                : 'Revealed from hand'
            }
          >
            {piles.revealed.map((c) => {
              const p = pool[c.guid];
              return (
                <div
                  key={c.guid}
                  className="rev-card"
                  onContextMenu={canActOnHand ? revealedHandMenu(c.guid) : undefined}
                  onMouseEnter={() => p && useUI.getState().setHover({ pool: p, rotIndex: 0 })}
                  onMouseLeave={() => useUI.getState().setHover(null)}
                >
                  <CardView pool={p} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="piles">
        <div
          className="pile"
          data-drop={`library:${pid}`}
          title={
            isMe
              ? 'Click: draw · drag top card out · right-click: library actions'
              : `${player.name}'s library — click to search · drag top card out`
          }
          onClick={pileDrag.guardClick(() =>
            isMe
              ? actions.drawCards(1)
              : useUI.getState().openModal({ kind: 'search', ownerId: pid })
          )}
          onContextMenu={libraryMenu}
          onPointerDown={
            libraryCount > 0
              ? pileDrag.start(topRevealedPool ? { pool: topRevealedPool } : {}, dropFromLibrary)
              : undefined
          }
          onPointerMove={pileDrag.move}
          onPointerUp={pileDrag.end}
          onPointerCancel={pileDrag.cancel}
        >
          {libraryCount > 0 && <CardView pool={topRevealedPool} />}
          <span className="pile-count">{libraryCount}</span>
          <span className="pile-label">library</span>
        </div>

        <div
          className="pile"
          data-drop={`graveyard:${pid}`}
          onContextMenu={pileMenu('graveyard')}
          onClick={pileDrag.guardClick(() =>
            useUI.getState().openModal({ kind: 'zone', zone: 'graveyard', zoneOwnerId: pid })
          )}
          title="Graveyard (click to expand · drag top card out)"
          onPointerDown={
            piles.gy[0]
              ? pileDrag.start(
                  { pool: pool[piles.gy[0].guid], rotIndex: piles.gy[0].rotIndex },
                  dropFromPileCard(piles.gy[0].guid)
                )
              : undefined
          }
          onPointerMove={pileDrag.move}
          onPointerUp={pileDrag.end}
          onPointerCancel={pileDrag.cancel}
        >
          {piles.gy[0] && <CardView pool={pool[piles.gy[0].guid]} rotIndex={piles.gy[0].rotIndex} />}
          <span className="pile-count">{piles.gy.length}</span>
          <span className="pile-label">grave</span>
        </div>

        <div
          className="pile"
          data-drop={`exile:${pid}`}
          onContextMenu={pileMenu('exile')}
          onClick={pileDrag.guardClick(() =>
            useUI.getState().openModal({ kind: 'zone', zone: 'exile', zoneOwnerId: pid })
          )}
          title="Exile (click to expand · drag top card out)"
          onPointerDown={
            piles.exile[0]
              ? pileDrag.start(
                  { pool: pool[piles.exile[0].guid], rotIndex: piles.exile[0].rotIndex },
                  dropFromPileCard(piles.exile[0].guid)
                )
              : undefined
          }
          onPointerMove={pileDrag.move}
          onPointerUp={pileDrag.end}
          onPointerCancel={pileDrag.cancel}
        >
          {piles.exile[0] && <CardView pool={pool[piles.exile[0].guid]} rotIndex={piles.exile[0].rotIndex} />}
          <span className="pile-count">{piles.exile.length}</span>
          <span className="pile-label">exile</span>
        </div>

        <div
          className="pile"
          data-drop={`command:${pid}`}
          onContextMenu={pileMenu('command')}
          onClick={pileDrag.guardClick(() =>
            useUI.getState().openModal({ kind: 'zone', zone: 'command', zoneOwnerId: pid })
          )}
          title="Command zone (drag commander to battlefield to cast)"
          onPointerDown={
            piles.command[0]
              ? pileDrag.start({ pool: pool[piles.command[0].guid] }, dropFromPileCard(piles.command[0].guid))
              : undefined
          }
          onPointerMove={pileDrag.move}
          onPointerUp={pileDrag.end}
          onPointerCancel={pileDrag.cancel}
        >
          {piles.command[0] && <CardView pool={pool[piles.command[0].guid]} />}
          <span className="pile-count">{piles.command.length}</span>
          <span className="pile-label">command</span>
        </div>

        <div className="pile" data-drop={`hand:${pid}`} title={`${player.name}'s hand`}
          style={{ borderStyle: 'solid' }}>
          <span className="pile-count">{handCount}</span>
          <span className="pile-label">hand</span>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, color: 'var(--ink-dim)' }}>🂠</div>
        </div>
      </div>
      {pileDrag.ghost &&
        // Portal: the ghost is position:fixed, but a transformed ancestor
        // (.hud.pos-top's translateX) would become its containing block and
        // offset it by the tray's position. From <body> it tracks the pointer.
        createPortal(
          <DragGhost
            pool={pileDrag.ghost.pool}
            rotIndex={pileDrag.ghost.rotIndex ?? 0}
            faceDown={!pileDrag.ghost.pool}
            x={pileDrag.ghost.x}
            y={pileDrag.ghost.y}
          />,
          document.body
        )}
    </div>
  );
}
