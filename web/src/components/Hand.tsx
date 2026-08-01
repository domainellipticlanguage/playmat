import { useRef, useState } from 'react';
import { useGame } from '../store';
import { useUI } from '../uiStore';
import * as actions from '../actions';
import { faceAt } from '../cards';
import { CARD_BACK_URL } from '../cards';
import { liveView, screenToWorld } from '../view';

export function Hand() {
  const hand = useGame((s) => s.hidden.hand);
  const pool = useGame((s) => s.pool);
  const cards = useGame((s) => s.cards);
  const me = useGame((s) => s.session?.playerId);
  const [ghost, setGhost] = useState<{ guid: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ guid: string; startX: number; startY: number; moved: boolean } | null>(null);

  const onPointerDown = (guid: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { guid, startX: e.clientX, startY: e.clientY, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6) {
      if (!d.moved) useUI.getState().setDragging(d.guid);
      d.moved = true;
    }
    if (d.moved) setGhost({ guid: d.guid, x: e.clientX, y: e.clientY });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setGhost(null);
    useUI.getState().setDragging(null);
    if (!d || !d.moved) return;
    const dropEl = document.elementFromPoint(e.clientX, e.clientY);
    const zoneTarget = dropEl?.closest('[data-drop]') as HTMLElement | null;
    if (zoneTarget) {
      const [zone, zoneOwnerId] = zoneTarget.dataset.drop!.split(':');
      if (zone !== 'hand') actions.moveCard(d.guid, { zone: zone as never, zoneOwnerId: zoneOwnerId || undefined });
      return;
    }
    if (dropEl?.closest('.battlefield-viewport')) {
      const r = dropEl.closest('.battlefield-viewport')!.getBoundingClientRect();
      const world = screenToWorld(liveView.current, e.clientX - r.left, e.clientY - r.top);
      actions.playFromHand(d.guid, world.x, world.y, e.shiftKey);
    }
  };

  const menuFor = (guid: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const c = cards[guid];
    useUI.getState().openCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Play', action: () => {
            const world = screenToWorld(liveView.current, window.innerWidth / 2, window.innerHeight / 2);
            actions.playFromHand(guid, world.x, world.y + 200, false);
          } },
        { label: 'Play face down', action: () => {
            const world = screenToWorld(liveView.current, window.innerWidth / 2, window.innerHeight / 2);
            actions.playFromHand(guid, world.x, world.y + 200, true);
          } },
        { label: c?.revealed ? 'Stop revealing' : 'Reveal to table', action: () => actions.revealFromHand(guid, !c?.revealed) },
        { sep: true, label: '' },
        { label: 'Discard', action: () => actions.moveCard(guid, { zone: 'graveyard' }) },
        { label: 'Exile', action: () => actions.moveCard(guid, { zone: 'exile' }) },
        { label: 'To library (top)', action: () => actions.moveCard(guid, { zone: 'library', libPos: 'top' }) },
        { label: 'To library (bottom)', action: () => actions.moveCard(guid, { zone: 'library', libPos: 'bottom' }) },
      ],
    });
  };

  return (
    <>
      <div className="hand-strip" data-drop={`hand:${me ?? ''}`}>
        {hand.map((guid) => {
          const p = pool[guid];
          const face = p ? faceAt(p, 0) : null;
          const revealed = cards[guid]?.revealed && cards[guid]?.zone === 'hand';
          return (
            <div
              key={guid}
              className={`hand-card${revealed ? ' revealed' : ''}`}
              onPointerDown={onPointerDown(guid)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onContextMenu={menuFor(guid)}
              onMouseEnter={() => p && useUI.getState().setHover({ pool: p, rotIndex: 0 })}
              onMouseLeave={() => useUI.getState().setHover(null)}
            >
              <img src={face?.img || CARD_BACK_URL} alt={face?.name ?? 'card'} draggable={false} />
            </div>
          );
        })}
      </div>
      {ghost && (
        <img
          src={pool[ghost.guid] ? faceAt(pool[ghost.guid], 0)?.img : CARD_BACK_URL}
          style={{
            position: 'fixed',
            left: ghost.x - 40,
            top: ghost.y - 56,
            width: 80,
            borderRadius: 5,
            opacity: 0.85,
            pointerEvents: 'none',
            zIndex: 80,
            boxShadow: '0 6px 18px rgba(0,0,0,0.7)',
          }}
        />
      )}
    </>
  );
}
