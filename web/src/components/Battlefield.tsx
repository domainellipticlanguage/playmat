import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CardState, ZoneName } from '@playmat/shared';
import { useGame } from '../store';
import { useUI } from '../uiStore';
import { sendEphemeral } from '../connection';
import * as actions from '../actions';
import { TableCard } from './TableCard';
import {
  CARD_H,
  CARD_W,
  TABLE,
  liveView,
  screenToWorld,
  seatAngle,
  viewRotation,
  worldToScreen,
  type ViewTransform,
} from '../view';

const OWNER_COLORS = ['#c9a34a', '#5f8dc9', '#b0483c', '#5d8a4e'];

interface DragState {
  guids: string[];
  /** world-space offset from pointer to each card's center */
  offsets: Record<string, { dx: number; dy: number }>;
  startScreen: { x: number; y: number };
  moved: boolean;
  fromHandGuid?: string;
}

export function Battlefield() {
  const session = useGame((s) => s.session);
  const cards = useGame((s) => s.cards);
  const pool = useGame((s) => s.pool);
  const players = useGame((s) => s.players);
  const cursors = useGame((s) => s.cursors);
  const drags = useGame((s) => s.drags);
  const selection = useGame((s) => s.selection);
  const prefs = useGame((s) => s.prefs);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewTransform>({ k: 0.3, theta: 0, cx: 400, cy: 300 });
  /** Viewport box in page coords, so the drag layer can sit exactly on top. */
  const [vpBox, setVpBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<{ startX: number; startY: number; cx: number; cy: number } | null>(null);
  const lastCursorSent = useRef(0);
  const lastDragSent = useRef(0);

  const mySeat = session?.seat ?? null;
  const theta = viewRotation(mySeat);

  // Fit view to viewport; keep liveView current for other components.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      setVpBox({ left: r.left, top: r.top, width: r.width, height: r.height });
      setView((v) => ({
        k: v.k > 0.05 && v.k !== 0.3 ? v.k : (Math.min(r.width, r.height) / TABLE) * 0.96,
        theta,
        cx: r.width / 2,
        cy: r.height / 2,
      }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [theta]);

  useEffect(() => {
    liveView.current = view;
  }, [view]);

  const seatOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of players) m.set(p.playerId, p.seat);
    return m;
  }, [players]);

  const battlefieldCards = useMemo(
    () => Object.values(cards).filter((c) => c.zone === 'battlefield'),
    [cards]
  );

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const publishCursor = (world: { x: number; y: number }) => {
    if (!session || !prefs.shareCursor) return;
    const minGap = 1000 / Math.max(2, prefs.cursorRate);
    const now = performance.now();
    if (now - lastCursorSent.current < minGap) return;
    lastCursorSent.current = now;
    sendEphemeral({ t: 'cursor', by: session.playerId, x: world.x, y: world.y, ts: Date.now() });
  };

  const publishDrag = (guid: string, world: { x: number; y: number }, force = false) => {
    if (!session) return;
    if (!force) {
      const minGap = 1000 / Math.max(2, prefs.cursorRate);
      const now = performance.now();
      if (now - lastDragSent.current < minGap) return;
      lastDragSent.current = now;
    }
    sendEphemeral({ t: 'drag', by: session.playerId, guid, x: world.x, y: world.y, ts: Date.now() });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (useUI.getState().ctxMenu) return;
    // A card's crucible menu portals into <body>, but React still bubbles its
    // pointerdown through this component tree. Left unhandled we fall to the
    // marquee branch below and setPointerCapture on the viewport, which steals
    // the pointerup — so the menu item never receives a click and every entry
    // looks dead. The menu stops mousedown, not pointerdown, hence this guard.
    if ((e.target as HTMLElement).closest('.mtg-card-menu, .ctx-menu')) return;
    const local = toLocal(e);
    const world = screenToWorld(view, local.x, local.y);
    const cardEl = (e.target as HTMLElement).closest('[data-guid]') as HTMLElement | null;

    // Pan: right-drag on the background (cards keep their context menu),
    // middle button, or alt+drag from anywhere.
    if ((e.button === 2 && !cardEl) || e.button === 1 || (e.button === 0 && e.altKey)) {
      panRef.current = { startX: local.x, startY: local.y, cx: view.cx, cy: view.cy };
      viewportRef.current!.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (cardEl) {
      const guid = cardEl.dataset.guid!;
      const st = useGame.getState();
      let guids: string[];
      if (e.shiftKey) {
        const sel = new Set(st.selection);
        sel.has(guid) ? sel.delete(guid) : sel.add(guid);
        st.setSelection([...sel]);
        return;
      }
      guids = st.selection.includes(guid) ? st.selection : [guid];
      if (!st.selection.includes(guid)) st.setSelection([]);
      const offsets: DragState['offsets'] = {};
      for (const g of guids) {
        const c = st.cards[g];
        if (c) offsets[g] = { dx: c.x - world.x, dy: c.y - world.y };
      }
      dragRef.current = { guids, offsets, startScreen: local, moved: false };
      useUI.getState().setDragging(guid);
      viewportRef.current!.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    // Empty space: marquee select.
    dragRef.current = null;
    setMarquee({ x0: local.x, y0: local.y, x1: local.x, y1: local.y });
    useGame.getState().setSelection([]);
    viewportRef.current!.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const local = toLocal(e);
    const world = screenToWorld(view, local.x, local.y);
    publishCursor(world);

    if (panRef.current) {
      const p = panRef.current;
      setView((v) => clampView({ ...v, cx: p.cx + (local.x - p.startX), cy: p.cy + (local.y - p.startY) }));
      return;
    }

    const drag = dragRef.current;
    if (drag) {
      const dist = Math.hypot(local.x - drag.startScreen.x, local.y - drag.startScreen.y);
      if (dist > 5) drag.moved = true;
      if (drag.moved) {
        const positions: Record<string, { x: number; y: number }> = {};
        for (const g of drag.guids) {
          const off = drag.offsets[g] ?? { dx: 0, dy: 0 };
          positions[g] = { x: world.x + off.dx, y: world.y + off.dy };
        }
        setDragPositions(positions);
        publishDrag(drag.guids[0], positions[drag.guids[0]]);
      }
      return;
    }

    if (marquee) setMarquee({ ...marquee, x1: local.x, y1: local.y });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (panRef.current) {
      panRef.current = null;
      return;
    }

    const drag = dragRef.current;
    dragRef.current = null;
    useUI.getState().setDragging(null);

    if (drag) {
      const st = useGame.getState();
      if (!drag.moved) {
        // Click = tap toggle (C-2), the Archidekt way.
        const c = st.cards[drag.guids[0]];
        if (c) actions.tapCards([drag.guids[0]], !c.tapped);
        setDragPositions({});
        return;
      }
      // Drop on a zone target? (piles/hand render above the battlefield)
      const target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest('[data-drop]') as HTMLElement | null;
      if (target) {
        const [zone, zoneOwnerId] = target.dataset.drop!.split(':');
        for (const g of drag.guids) {
          // Another player's pile rejects the drop (the card snaps back) rather
          // than quietly rerouting to your own zone of the same kind.
          if (actions.canPlaceIn(g, zone as ZoneName, zoneOwnerId || undefined)) {
            actions.moveCard(g, { zone: zone as ZoneName });
          }
        }
      } else {
        const moves = drag.guids
          .map((g) => ({ guid: g, ...dragPositions[g] }))
          .filter((m) => Number.isFinite(m.x));
        if (moves.length) {
          // E-5 for the ghost: one final unthrottled position at the exact
          // drop point, so peers' ghosts sit where the card will land while
          // the authoritative state event is still in flight.
          publishDrag(drag.guids[0], dragPositions[drag.guids[0]], true);
          actions.moveCardsGroup(moves);
        }
      }
      if (session) sendEphemeral({ t: 'dragend', by: session.playerId, guid: drag.guids[0], ts: Date.now() });
      setDragPositions({});
      return;
    }

    if (marquee) {
      const { x0, y0, x1, y1 } = marquee;
      const [lo_x, hi_x] = [Math.min(x0, x1), Math.max(x0, x1)];
      const [lo_y, hi_y] = [Math.min(y0, y1), Math.max(y0, y1)];
      if (hi_x - lo_x > 8 || hi_y - lo_y > 8) {
        const hit = battlefieldCards
          .filter((c) => {
            const s = worldToScreen(view, c.x, c.y);
            return s.x >= lo_x && s.x <= hi_x && s.y >= lo_y && s.y <= hi_y;
          })
          .map((c) => c.guid);
        useGame.getState().setSelection(hit);
      }
      setMarquee(null);
    }
  };

  /** Keep the table from being flung entirely off-screen. */
  const clampView = (v: ViewTransform): ViewTransform => {
    const el = viewportRef.current;
    if (!el) return v;
    const r = el.getBoundingClientRect();
    const reach = (TABLE / 2) * v.k + 40;
    return {
      ...v,
      cx: Math.min(r.width / 2 + reach, Math.max(r.width / 2 - reach, v.cx)),
      cy: Math.min(r.height / 2 + reach, Math.max(r.height / 2 - reach, v.cy)),
    };
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    // Wheel and two-finger scroll zoom toward the cursor; pinch (which
    // arrives as ctrl+wheel) zooms with matching sensitivity. Panning is
    // right-drag on the background.
    const local = toLocal(e);
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0012));
    setView((v) => {
      const k = Math.min(1.4, Math.max(0.08, v.k * factor));
      const scale = k / v.k;
      return clampView({ ...v, k, cx: local.x - (local.x - v.cx) * scale, cy: local.y - (local.y - v.cy) * scale });
    });
  };

  const faceAngleOverride = prefs.faceOpponentCards ? seatAngle(mySeat) : null;
  const surfaceInset = 60;
  const worldTransform = `translate(${view.cx}px, ${view.cy}px) rotate(${view.theta}deg) scale(${view.k}) translate(${-TABLE / 2}px, ${-TABLE / 2}px)`;

  const renderCard = (c: CardState) => (
    <TableCard
      key={c.guid}
      card={c}
      pool={pool[c.guid]}
      seatOfController={seatOf.get(c.controllerId) ?? 0}
      dragPos={dragPositions[c.guid] ?? null}
      remoteDrag={drags[c.guid] && !dragPositions[c.guid] ? drags[c.guid] : null}
      selected={selection.includes(c.guid)}
      faceAngleOverride={faceAngleOverride}
      ownerColor={OWNER_COLORS[seatOf.get(c.ownerId) ?? 0] ?? '#888'}
    />
  );

  // Cards under my pointer right now move to an overlay above the player HUDs
  // (see .drag-layer) so they don't slide beneath someone's life total
  // mid-drag. Only local drags — a peer's drag ghost stays in the world.
  const lifted = battlefieldCards.filter((c) => dragPositions[c.guid]);

  return (
    <div
      ref={viewportRef}
      className="battlefield-viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => {
        if (!(e.target as HTMLElement).closest('[data-guid]')) e.preventDefault();
      }}
    >
      <div className="world" style={{ transform: worldTransform }}>
        <div
          className="table-surface"
          style={{
            left: surfaceInset,
            top: surfaceInset,
            width: TABLE - surfaceInset * 2,
            height: TABLE - surfaceInset * 2,
            backgroundImage: 'var(--table-image, url(/table.jpg))',
          }}
        />
        {battlefieldCards.filter((c) => !dragPositions[c.guid]).map(renderCard)}
        {Object.entries(cursors).map(([pid, cur]) => (
          <div
            key={pid}
            className="cursor-dot"
            style={{ transform: `translate(${cur.x}px, ${cur.y}px) rotate(${-view.theta}deg) scale(${1 / view.k})` }}
          >
            <div className="dot" style={{ background: OWNER_COLORS[seatOf.get(pid) ?? 0] ?? '#aaa' }} />
            <div className="label">{cur.name}</div>
          </div>
        ))}
      </div>
      {marquee && (
        <div
          className="marquee"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}
      <div className="help-hint">
        click: tap · drag: move · shift-click: multi-select · drag empty: box select ·
        right-drag: pan · scroll or pinch: zoom
      </div>
      {lifted.length > 0 &&
        createPortal(
          <div
            className="drag-layer"
            style={{ left: vpBox.left, top: vpBox.top, width: vpBox.width, height: vpBox.height }}
          >
            {/* Same transform as the real world, so the card doesn't shift a
                pixel when it moves between the two layers. */}
            <div className="world" style={{ transform: worldTransform }}>
              {lifted.map(renderCard)}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
