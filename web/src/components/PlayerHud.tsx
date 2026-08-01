import { useMemo, useRef, useState } from 'react';
import type { PlayerState, SeatRecord, ZoneName } from '@playmat/shared';
import { useGame } from '../store';
import { useUI } from '../uiStore';
import * as actions from '../actions';
import { CARD_BACK_URL, faceAt } from '../cards';
import { liveView, relativeEdge, screenToWorld } from '../view';

const PLAYER_COUNTERS = ['poison', 'energy', 'experience'];

/** Where a pile drag ended up. */
type PileDropTarget =
  | { kind: 'zone'; zone: ZoneName; zoneOwnerId?: string }
  | { kind: 'battlefield'; x: number; y: number };

type PileDropFn = (target: PileDropTarget, shiftKey: boolean) => void;

/**
 * Drag-from-pile plumbing: piles are drag sources as well as drop targets.
 * Below the movement threshold the gesture stays a click (draw / open modal);
 * past it a ghost follows the pointer and the drop function fires on release.
 */
function usePileDrag() {
  const [ghost, setGhost] = useState<{ img: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean; img: string; drop: PileDropFn } | null>(null);
  const suppressClick = useRef(false);

  const start = (img: string, drop: PileDropFn) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, moved: false, img, drop };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const move = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6) {
      d.moved = true;
      useUI.getState().setDragging('pile');
    }
    if (d.moved) setGhost({ img: d.img, x: e.clientX, y: e.clientY });
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

  return { ghost, start, move, end, guardClick };
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

  const lastSeen = presence[pid] ?? (isMe ? Date.now() : 0);
  const presenceClass = isMe || Date.now() - lastSeen < 25_000 ? 'connected' : lastSeen ? 'away' : '';

  const pileDrag = usePileDrag();

  /** Drag the (hidden) top of my library: battlefield = play, hand = draw, graveyard = mill. */
  const dropFromLibrary: PileDropFn = (target, shift) => {
    const top = useGame.getState().hidden.library[0];
    if (!top) return;
    if (target.kind === 'battlefield') {
      actions.moveCard(top, { zone: 'battlefield', x: target.x, y: target.y, faceDown: shift });
    } else if (target.zone === 'hand' && (target.zoneOwnerId ?? pid) === pid) {
      actions.drawCards(1);
    } else if (target.zone !== 'library') {
      actions.moveCard(top, { zone: target.zone, zoneOwnerId: target.zoneOwnerId });
    }
  };

  /** Drag the top card of a public pile (graveyard/exile/command) anywhere. */
  const dropFromPileCard =
    (guid: string): PileDropFn =>
    (target, shift) => {
      if (target.kind === 'battlefield') {
        actions.moveCard(guid, { zone: 'battlefield', x: target.x, y: target.y, faceDown: shift });
      } else {
        actions.moveCard(guid, {
          zone: target.zone,
          zoneOwnerId: target.zoneOwnerId,
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

  const libraryMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!isMe) return;
    const ui = useUI.getState();
    ui.openCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Draw 1  (D)', action: () => actions.drawCards(1) },
        { label: 'Draw 7', action: () => actions.drawCards(7) },
        { label: 'Shuffle', action: () => actions.shuffleLibrary() },
        { sep: true, label: '' },
        { label: 'Scry / look at top…', action: () => {
            const n = Number(prompt('Look at how many cards?', '3'));
            if (n > 0) ui.openModal({ kind: 'peek', count: n, mode: 'scry' });
          } },
        { label: 'Search library', action: () => ui.openModal({ kind: 'search' }) },
        { label: 'Mill 1', action: () => {
            const top = useGame.getState().hidden.library[0];
            if (top) actions.moveCard(top, { zone: 'graveyard' });
          } },
        { sep: true, label: '' },
        { label: state.topRevealed ? 'Stop playing with top revealed' : 'Play with top revealed',
          action: () => actions.setTopRevealed(!state.topRevealed) },
      ],
    });
  };

  const lifeAdjust = (delta: number) => actions.setLife(pid, state.life + delta);

  return (
    <div className={`hud pos-${edge}${room?.turnPlayerId === pid ? ' turn' : ''}`}>
      <div className="who">
        <div className="name">
          <span className={`presence ${presenceClass}`} title={presenceClass || 'not seen yet'} />
          {player.name} {isMe && <span style={{ color: 'var(--ink-dim)' }}>(you)</span>}
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
          <div className="revealed-strip" title="Revealed from hand">
            {piles.revealed.map((c) => {
              const p = pool[c.guid];
              const face = p ? faceAt(p, 0) : null;
              return (
                <img
                  key={c.guid}
                  src={face?.img || CARD_BACK_URL}
                  alt={face?.name}
                  onMouseEnter={() => p && useUI.getState().setHover({ pool: p, rotIndex: 0 })}
                  onMouseLeave={() => useUI.getState().setHover(null)}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="piles">
        <div
          className="pile"
          data-drop={`library:${pid}`}
          title={isMe ? 'Click: draw · drag top card out · right-click: library actions' : `${player.name}'s library`}
          onClick={pileDrag.guardClick(() => isMe && actions.drawCards(1))}
          onContextMenu={libraryMenu}
          onPointerDown={
            isMe && libraryCount > 0
              ? pileDrag.start(
                  topRevealedPool ? faceAt(topRevealedPool, 0)?.img || CARD_BACK_URL : CARD_BACK_URL,
                  dropFromLibrary
                )
              : undefined
          }
          onPointerMove={pileDrag.move}
          onPointerUp={pileDrag.end}
        >
          {libraryCount > 0 &&
            (topRevealedPool ? (
              <img src={faceAt(topRevealedPool, 0)?.img || CARD_BACK_URL} alt="top of library (revealed)" />
            ) : (
              <img src={CARD_BACK_URL} alt="library" />
            ))}
          <span className="pile-count">{libraryCount}</span>
          <span className="pile-label">library</span>
        </div>

        <div
          className="pile"
          data-drop={`graveyard:${pid}`}
          onClick={pileDrag.guardClick(() =>
            useUI.getState().openModal({ kind: 'zone', zone: 'graveyard', zoneOwnerId: pid })
          )}
          title="Graveyard (click to expand · drag top card out)"
          onPointerDown={
            piles.gy[0]
              ? pileDrag.start(
                  faceAt(pool[piles.gy[0].guid], piles.gy[0].rotIndex)?.img || CARD_BACK_URL,
                  dropFromPileCard(piles.gy[0].guid)
                )
              : undefined
          }
          onPointerMove={pileDrag.move}
          onPointerUp={pileDrag.end}
        >
          {piles.gy[0] && <img src={faceAt(pool[piles.gy[0].guid], piles.gy[0].rotIndex)?.img || CARD_BACK_URL} alt="graveyard top" />}
          <span className="pile-count">{piles.gy.length}</span>
          <span className="pile-label">grave</span>
        </div>

        <div
          className="pile"
          data-drop={`exile:${pid}`}
          onClick={pileDrag.guardClick(() =>
            useUI.getState().openModal({ kind: 'zone', zone: 'exile', zoneOwnerId: pid })
          )}
          title="Exile (click to expand · drag top card out)"
          onPointerDown={
            piles.exile[0]
              ? pileDrag.start(
                  faceAt(pool[piles.exile[0].guid], piles.exile[0].rotIndex)?.img || CARD_BACK_URL,
                  dropFromPileCard(piles.exile[0].guid)
                )
              : undefined
          }
          onPointerMove={pileDrag.move}
          onPointerUp={pileDrag.end}
        >
          {piles.exile[0] && <img src={faceAt(pool[piles.exile[0].guid], piles.exile[0].rotIndex)?.img || CARD_BACK_URL} alt="exile top" />}
          <span className="pile-count">{piles.exile.length}</span>
          <span className="pile-label">exile</span>
        </div>

        <div
          className="pile"
          data-drop={`command:${pid}`}
          onClick={pileDrag.guardClick(() =>
            useUI.getState().openModal({ kind: 'zone', zone: 'command', zoneOwnerId: pid })
          )}
          title="Command zone (drag commander to battlefield to cast)"
          onPointerDown={
            piles.command[0]
              ? pileDrag.start(
                  faceAt(pool[piles.command[0].guid], 0)?.img || CARD_BACK_URL,
                  dropFromPileCard(piles.command[0].guid)
                )
              : undefined
          }
          onPointerMove={pileDrag.move}
          onPointerUp={pileDrag.end}
        >
          {piles.command[0] && (
            <img src={faceAt(pool[piles.command[0].guid], 0)?.img || CARD_BACK_URL} alt="command zone" />
          )}
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
      {pileDrag.ghost && (
        <img
          src={pileDrag.ghost.img}
          style={{
            position: 'fixed',
            left: pileDrag.ghost.x - 40,
            top: pileDrag.ghost.y - 56,
            width: 80,
            borderRadius: 5,
            opacity: 0.85,
            pointerEvents: 'none',
            zIndex: 80,
            boxShadow: '0 6px 18px rgba(0,0,0,0.7)',
          }}
        />
      )}
    </div>
  );
}
