import { useEffect, useRef, useState } from 'react';
import type { ZoneName } from '@playmat/shared';
import { useGame } from '../store';
import { useUI } from '../uiStore';
import * as actions from '../actions';
import { handInsert } from '../handDrop';
import { liveView, screenToWorld } from '../view';
import { CardView, DragGhost, closeCrucibleMenus } from './CardView';

/** Resting overlap, and the tightest we'll squeeze before cards get ungrabbable. */
const REST_OVERLAP = -14;
const MAX_OVERLAP = -46;
/** Extra margin each side of the insertion slot while a drag hovers the hand. */
const GAP = 30;

export function Hand() {
  const hand = useGame((s) => s.hidden.hand);
  const pool = useGame((s) => s.pool);
  const cards = useGame((s) => s.cards);
  const me = useGame((s) => s.session?.playerId);
  const draggingGuid = useUI((s) => s.dragging);
  const [ghost, setGhost] = useState<{ guid: string; x: number; y: number } | null>(null);
  /** Insertion slot (index among visible cards) while a drag hovers the strip. */
  const [insert, setInsert] = useState<number | null>(null);
  const dragRef = useRef<{ guid: string; startX: number; startY: number; moved: boolean } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const cardWRef = useRef(108);
  const [overlap, setOverlap] = useState(REST_OVERLAP);

  // The card being dragged out collapses (width 0) so the fan closes around
  // it — one physical card, carried by the ghost, not a ghostly double. It
  // stays mounted: unmounting would break its pointer capture mid-drag.
  const lifted = draggingGuid && hand.includes(draggingGuid) ? draggingGuid : null;
  // Would dropping the dragged card here mean anything? My own cards only.
  const droppable =
    !!draggingGuid && (!!lifted || actions.canPlaceIn(draggingGuid, 'hand', me ?? undefined));

  // Squeeze the fan to whatever width the strip actually has. Each card
  // contributes (width + 2 * margin) to the flex row, so solving that for the
  // available width gives the overlap that exactly fits. Without this a hand
  // wider than the strip spills past both ends and .table-main clips it away.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const fit = () => {
      const avail = el.clientWidth - 16; // .hand-strip padding
      // Count what's actually visible: the lifted card is width 0, and fitting
      // for it anyway would space the fan differently mid-drag than after the
      // drop lands (hand.length and lifted change together, so no re-snap).
      const n = hand.length - (lifted ? 1 : 0);
      if (n < 2 || avail <= 0) return setOverlap(REST_OVERLAP);
      // Measured, not hardcoded: .hand-card width changes with the compact
      // media query, and the strip resizes with the window either way.
      const cardW = el.querySelector<HTMLElement>('.hand-card:not(.lifted)')?.offsetWidth;
      if (cardW) cardWRef.current = cardW;
      const exact = (avail / n - (cardW ?? cardWRef.current)) / 2;
      setOverlap(Math.max(MAX_OVERLAP, Math.min(REST_OVERLAP, exact)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hand.length, lifted]);

  // While a droppable drag is live (from the hand OR the battlefield), track
  // the pointer at window level: the dragging component holds pointer capture,
  // so the strip never gets its own pointerover — but captured pointer events
  // still bubble to window. Over the strip, compute the insertion slot.
  useEffect(() => {
    if (!droppable) return;
    const onMove = (e: PointerEvent) => {
      const el = stripRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const inside =
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 24 && e.clientY <= r.bottom;
      if (!inside) {
        handInsert.index = null;
        setInsert(null);
        return;
      }
      const els = el.querySelectorAll<HTMLElement>('.hand-card:not(.lifted)');
      let idx = els.length;
      for (let i = 0; i < els.length; i++) {
        const cr = els[i].getBoundingClientRect();
        if (e.clientX < cr.left + cr.width / 2) {
          idx = i;
          break;
        }
      }
      handInsert.index = idx;
      setInsert(idx);
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      handInsert.index = null;
      setInsert(null);
    };
  }, [droppable]);

  const onPointerDown = (guid: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    closeCrucibleMenus(); // preventDefault below suppresses the mousedown it needs
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
    // Read before setDragging(null) — the tracking effect's cleanup clears it.
    const slot = handInsert.index;
    dragRef.current = null;
    setGhost(null);
    useUI.getState().setDragging(null);
    if (!d || !d.moved) return;
    if (slot != null) {
      actions.reorderHand(d.guid, slot);
      return;
    }
    const dropEl = document.elementFromPoint(e.clientX, e.clientY);
    const zoneTarget = dropEl?.closest('[data-drop]') as HTMLElement | null;
    if (zoneTarget) {
      const [zone, zoneOwnerId] = zoneTarget.dataset.drop!.split(':');
      // Dropping on another player's pile is a no-op rather than a move home:
      // a card only ever enters its own owner's zones. (My own hand was
      // handled above via the insertion slot.)
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

  /** Widen the margins around the insertion slot so a gap opens for the drop. */
  const gapFor = (vi: number): React.CSSProperties | undefined => {
    if (insert == null) return undefined;
    const style: React.CSSProperties = {};
    if (vi === insert) style.marginLeft = overlap + GAP;
    if (vi === insert - 1) style.marginRight = overlap + GAP;
    return style.marginLeft !== undefined || style.marginRight !== undefined ? style : undefined;
  };

  let vi = 0; // index among visible (non-lifted) cards, what `insert` counts
  return (
    <>
      <div
        ref={stripRef}
        className={`hand-strip${droppable ? ' drop-ready' : ''}${insert != null ? ' drop-hover' : ''}`}
        data-drop={`hand:${me ?? ''}`}
        style={{ '--hand-overlap': `${overlap}px` } as React.CSSProperties}
      >
        {hand.map((guid) => {
          const p = pool[guid];
          const revealed = cards[guid]?.revealed && cards[guid]?.zone === 'hand';
          const isLifted = guid === lifted;
          const myVi = isLifted ? -1 : vi++;
          return (
            <div
              key={guid}
              data-guid={guid}
              className={`hand-card${revealed ? ' revealed' : ''}${isLifted ? ' lifted' : ''}`}
              style={isLifted ? undefined : gapFor(myVi)}
              onPointerDown={onPointerDown(guid)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onContextMenu={menuFor(guid)}
              onMouseEnter={() => !useUI.getState().dragging && p && useUI.getState().setHover({ pool: p, rotIndex: 0 })}
              onMouseLeave={() => useUI.getState().setHover(null)}
            >
              <CardView pool={p} />
            </div>
          );
        })}
      </div>
      {ghost && (
        <DragGhost
          pool={pool[ghost.guid]}
          x={ghost.x}
          y={ghost.y}
          // Over the hand the ghost takes hand-card size, so returning a card
          // (or reordering) reads as sliding it back into the fan.
          w={insert != null ? cardWRef.current : undefined}
        />
      )}
    </>
  );
}
