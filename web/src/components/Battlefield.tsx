import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CardState, PlayerState, PoolCard, ZoneName } from '@playmat/shared';
import { useGame } from '../store';
import { useUI } from '../uiStore';
import { sendEphemeral } from '../connection';
import * as actions from '../actions';
import { TableCard } from './TableCard';
import { paletteColor, playmatImageUrl } from '../colors';
import {
  CARD_H,
  CARD_W,
  TABLE,
  liveView,
  matRect,
  screenToWorld,
  seatAngle,
  viewRotation,
  type MatRect,
  type ViewTransform,
} from '../view';

/**
 * One player's mat: a rounded rect in world coordinates, their color on the
 * border, their pattern/art as the surface. The art is rendered in a child
 * div rotated to the seat's orientation (dims swapped for east/west) so a
 * commander portrait faces its player.
 */
function Playmat({
  rect,
  seat,
  ps,
  name,
  pool,
}: {
  rect: MatRect;
  seat: number;
  ps: PlayerState | undefined;
  name: string;
  pool: Record<string, PoolCard>;
}) {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const angle = seatAngle(seat);
  const sideways = angle === 90 || angle === 270;
  const color = paletteColor(ps?.color, seat);
  const art = playmatImageUrl(ps, seat, pool);
  return (
    <div
      className="playmat"
      style={{
        left: rect.x0,
        top: rect.y0,
        width: w,
        height: h,
        borderColor: `${color.hex}99`,
        boxShadow: `0 0 60px ${color.hex}26 inset`,
      }}
    >
      <div
        className="playmat-art"
        style={{
          width: sideways ? h : w,
          height: sideways ? w : h,
          transform: `translate(-50%, -50%) rotate(${angle}deg)`,
          backgroundImage: `url(${art})`,
        }}
      >
        <span className="playmat-name" style={{ color: `${color.hex}cc` }}>
          {name}
        </span>
      </div>
    </div>
  );
}

interface DragState {
  pointerId: number;
  guids: string[];
  /** world-space offset from pointer to each card's center */
  offsets: Record<string, { dx: number; dy: number }>;
  startScreen: { x: number; y: number };
  moved: boolean;
  fromHandGuid?: string;
}

/**
 * View gesture in progress. One pointer on the background pans (mouse drag
 * or one finger); a second touch upgrades the pan to a pinch, which zooms
 * by the finger-distance ratio AND pans by the midpoint's travel — so two
 * fingers moving together is also a pan, Figma-style. Everything speaks
 * Pointer Events, so mouse/touch/pen share one code path.
 */
type ViewGesture =
  | { mode: 'pan'; pointerId: number; startX: number; startY: number; cx: number; cy: number }
  | { mode: 'pinch'; ids: [number, number]; m0: { x: number; y: number }; d0: number; view0: ViewTransform };

export function Battlefield() {
  const session = useGame((s) => s.session);
  const cards = useGame((s) => s.cards);
  const pool = useGame((s) => s.pool);
  const players = useGame((s) => s.players);
  const playerStates = useGame((s) => s.playerStates);
  const cursors = useGame((s) => s.cursors);
  const drags = useGame((s) => s.drags);
  const selection = useGame((s) => s.selection);
  const prefs = useGame((s) => s.prefs);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewTransform>({ k: 0.3, theta: 0, cx: 400, cy: 300 });
  /** Viewport box in page coords, so the drag layer can sit exactly on top. */
  const [vpBox, setVpBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }>>({});
  const dragRef = useRef<DragState | null>(null);
  const gestureRef = useRef<ViewGesture | null>(null);
  /** Local coords of every pointer currently down on the viewport. */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
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

  /** A player's display color (their pick, else their seat's default). */
  const colorOf = (pid: string) =>
    paletteColor(playerStates[pid]?.color, seatOf.get(pid) ?? 0).hex;

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
    // pointerdown through this component tree. Left unhandled we'd start a pan
    // and setPointerCapture on the viewport, which steals the pointerup — so
    // the menu item never receives a click and every entry looks dead. The
    // menu stops mousedown, not pointerdown, hence this guard.
    if ((e.target as HTMLElement).closest('.mtg-card-menu, .ctx-menu')) return;
    const local = toLocal(e);
    pointersRef.current.set(e.pointerId, local);
    const world = screenToWorld(view, local.x, local.y);
    const cardEl = (e.target as HTMLElement).closest('[data-guid]') as HTMLElement | null;

    // Extra fingers during a card drag change nothing.
    if (dragRef.current) return;

    // Second touch while panning: upgrade to a pinch, wherever it landed.
    if (gestureRef.current?.mode === 'pan' && pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.entries()];
      gestureRef.current = {
        mode: 'pinch',
        ids: [a[0], b[0]],
        m0: { x: (a[1].x + b[1].x) / 2, y: (a[1].y + b[1].y) / 2 },
        d0: Math.max(1, Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y)),
        view0: view,
      };
      viewportRef.current!.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (gestureRef.current) return;

    if (e.button === 0 && !e.altKey && cardEl) {
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
      dragRef.current = { pointerId: e.pointerId, guids, offsets, startScreen: local, moved: false };
      useUI.getState().setDragging(guid);
      viewportRef.current!.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    // Everything else drags the view: left/touch on the background, middle
    // button, right-drag on the background (cards keep their context menu),
    // or alt+drag from anywhere.
    if (e.button > 2 || (e.button === 2 && cardEl)) return;
    if (e.button === 0 && !e.altKey) useGame.getState().setSelection([]);
    gestureRef.current = { mode: 'pan', pointerId: e.pointerId, startX: local.x, startY: local.y, cx: view.cx, cy: view.cy };
    viewportRef.current!.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const local = toLocal(e);
    if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, local);
    const world = screenToWorld(view, local.x, local.y);
    publishCursor(world);

    const ges = gestureRef.current;
    if (ges?.mode === 'pinch') {
      const a = pointersRef.current.get(ges.ids[0]);
      const b = pointersRef.current.get(ges.ids[1]);
      if (!a || !b) return;
      const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const d1 = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const k = Math.min(1.4, Math.max(0.08, ges.view0.k * (d1 / ges.d0)));
      const scale = k / ges.view0.k;
      setView(() =>
        clampView({
          ...ges.view0,
          k,
          cx: m1.x - (ges.m0.x - ges.view0.cx) * scale,
          cy: m1.y - (ges.m0.y - ges.view0.cy) * scale,
        })
      );
      return;
    }
    if (ges?.mode === 'pan') {
      if (e.pointerId !== ges.pointerId) return;
      setView((v) => clampView({ ...v, cx: ges.cx + (local.x - ges.startX), cy: ges.cy + (local.y - ges.startY) }));
      return;
    }

    const drag = dragRef.current;
    if (drag && e.pointerId === drag.pointerId) {
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
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);

    const ges = gestureRef.current;
    if (ges?.mode === 'pinch') {
      if (!ges.ids.includes(e.pointerId)) return;
      // One finger left: back to a pan, re-baselined where that finger is now.
      const otherId = ges.ids[0] === e.pointerId ? ges.ids[1] : ges.ids[0];
      const survivor = pointersRef.current.get(otherId);
      gestureRef.current = survivor
        ? { mode: 'pan', pointerId: otherId, startX: survivor.x, startY: survivor.y, cx: view.cx, cy: view.cy }
        : null;
      return;
    }
    if (ges?.mode === 'pan') {
      if (e.pointerId === ges.pointerId) gestureRef.current = null;
      return;
    }

    const drag = dragRef.current;
    if (drag && e.pointerId !== drag.pointerId) return;
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
        const refused: string[] = [];
        for (const g of drag.guids) {
          // Another player's pile rejects the drop (the card snaps back) rather
          // than quietly rerouting to your own zone of the same kind.
          if (actions.canPlaceIn(g, zone as ZoneName, zoneOwnerId || undefined)) {
            actions.moveCard(g, { zone: zone as ZoneName });
          } else {
            refused.push(g);
          }
        }
        // Tell peers "nothing moved" so their drag ghosts retire now instead
        // of hovering at the refused pile for the dragend grace period.
        if (refused.length) actions.reassertCards(refused);
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
    }
  };

  /** Browser reclaimed a pointer (OS gesture, tab switch): abandon cleanly. */
  const onPointerCancel = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    const ges = gestureRef.current;
    if (ges?.mode === 'pinch' && ges.ids.includes(e.pointerId)) {
      const otherId = ges.ids[0] === e.pointerId ? ges.ids[1] : ges.ids[0];
      const survivor = pointersRef.current.get(otherId);
      gestureRef.current = survivor
        ? { mode: 'pan', pointerId: otherId, startX: survivor.x, startY: survivor.y, cx: view.cx, cy: view.cy }
        : null;
      return;
    }
    if (ges?.mode === 'pan' && e.pointerId === ges.pointerId) {
      gestureRef.current = null;
      return;
    }
    const drag = dragRef.current;
    if (drag && e.pointerId === drag.pointerId) {
      dragRef.current = null;
      useUI.getState().setDragging(null);
      setDragPositions({});
      if (session) sendEphemeral({ t: 'dragend', by: session.playerId, guid: drag.guids[0], ts: Date.now() });
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

  // Wheel and two-finger scroll zoom toward the cursor; pinch (which arrives
  // as ctrl+wheel) zooms with matching sensitivity. React attaches onWheel
  // passively — preventDefault there is a no-op plus a console warning — so
  // the listener goes on the node directly, non-passive, via the effect below.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const local = toLocal(e);
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0012));
    setView((v) => {
      const k = Math.min(1.4, Math.max(0.08, v.k * factor));
      const scale = k / v.k;
      return clampView({ ...v, k, cx: local.x - (local.x - v.cx) * scale, cy: local.y - (local.y - v.cy) * scale });
    });
  };
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);

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
      ownerColor={colorOf(c.ownerId)}
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
      onPointerCancel={onPointerCancel}
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
        {players.map((p) => (
          <Playmat
            key={p.playerId}
            rect={matRect(p.seat, (q) => players.some((o) => o.seat === q))}
            seat={p.seat}
            ps={playerStates[p.playerId]}
            name={p.name}
            pool={pool}
          />
        ))}
        {battlefieldCards.filter((c) => !dragPositions[c.guid]).map(renderCard)}
        {Object.entries(cursors).map(([pid, cur]) => (
          <div
            key={pid}
            className="cursor-dot"
            style={{ transform: `translate(${cur.x}px, ${cur.y}px) rotate(${-view.theta}deg) scale(${1 / view.k})` }}
          >
            <div className="dot" style={{ background: colorOf(pid) }} />
            <div className="label">{cur.name}</div>
          </div>
        ))}
      </div>
      <div className="help-hint">
        click: tap · drag card: move · drag table: pan · scroll or pinch: zoom ·
        shift-click: multi-select
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
