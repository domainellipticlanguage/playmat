import { useEffect, useRef, useState } from 'react';
import type { ZoneName } from '@playmat/shared';
import { useGame } from '../store';
import { useUI } from '../uiStore';
import * as actions from '../actions';
import { liveView, screenToWorld } from '../view';
import { CardView, DragGhost } from './CardView';

/** Resting overlap, and the tightest we'll squeeze before cards get ungrabbable. */
const REST_OVERLAP = -14;
const MAX_OVERLAP = -46;

export function Hand() {
  const hand = useGame((s) => s.hidden.hand);
  const pool = useGame((s) => s.pool);
  const cards = useGame((s) => s.cards);
  const me = useGame((s) => s.session?.playerId);
  const [ghost, setGhost] = useState<{ guid: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ guid: string; startX: number; startY: number; moved: boolean } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [overlap, setOverlap] = useState(REST_OVERLAP);

  // Squeeze the fan to whatever width the strip actually has. Each card
  // contributes (width + 2 * margin) to the flex row, so solving that for the
  // available width gives the overlap that exactly fits. Without this a hand
  // wider than the strip spills past both ends and .table-main clips it away.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const fit = () => {
      const avail = el.clientWidth - 16; // .hand-strip padding
      const n = hand.length;
      if (n < 2 || avail <= 0) return setOverlap(REST_OVERLAP);
      // Measured, not hardcoded: .hand-card width changes with the compact
      // media query, and the strip resizes with the window either way.
      const cardW = el.querySelector<HTMLElement>('.hand-card')?.offsetWidth ?? 108;
      const exact = (avail / n - cardW) / 2;
      setOverlap(Math.max(MAX_OVERLAP, Math.min(REST_OVERLAP, exact)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hand.length]);

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

  /** Browser reclaimed the pointer (e.g. an OS gesture): abandon the drag. */
  const onPointerCancel = () => {
    dragRef.current = null;
    setGhost(null);
    useUI.getState().setDragging(null);
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
      // Dropping on another player's pile is a no-op rather than a move home:
      // a card only ever enters its own owner's zones.
      if (zone !== 'hand' && actions.canPlaceIn(d.guid, zone as ZoneName, zoneOwnerId || undefined)) {
        actions.moveCard(d.guid, { zone: zone as ZoneName });
      }
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
            const p = actions.autoPlayPosition(guid);
            actions.playFromHand(guid, p.x, p.y, false);
          } },
        { label: 'Play face down', action: () => {
            const p = actions.autoPlayPosition(guid);
            actions.playFromHand(guid, p.x, p.y, true);
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
      <div
        ref={stripRef}
        className="hand-strip"
        data-drop={`hand:${me ?? ''}`}
        style={{ '--hand-overlap': `${overlap}px` } as React.CSSProperties}
      >
        {hand.map((guid) => {
          const p = pool[guid];
          const revealed = cards[guid]?.revealed && cards[guid]?.zone === 'hand';
          return (
            <div
              key={guid}
              className={`hand-card${revealed ? ' revealed' : ''}`}
              onPointerDown={onPointerDown(guid)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onContextMenu={menuFor(guid)}
              onMouseEnter={() => p && useUI.getState().setHover({ pool: p, rotIndex: 0 })}
              onMouseLeave={() => useUI.getState().setHover(null)}
            >
              <CardView pool={p} />
            </div>
          );
        })}
      </div>
      {ghost && <DragGhost pool={pool[ghost.guid]} x={ghost.x} y={ghost.y} />}
    </>
  );
}
