/**
 * Table geometry. World coordinates are fixed (README §Other thoughts):
 * seat 0's home edge is south. Every client renders the same world rotated
 * so THEIR edge is at the bottom, as a final affine step.
 */

/** World is a TABLE x TABLE square. */
export const TABLE = 2400;
/** Card width in world units (height = ratio 1.4). Sized so a card is
 * readable at fit-to-screen zoom (~11 cards across the whole table). */
export const CARD_W = 220;
export const CARD_H = 308;

/** Rotation (deg) of a seat's cards in world space: their "up" faces them. */
export const SEAT_CARD_ANGLE = [0, 180, 270, 90];
/** Which viewport edge a seat's HUD lands on, relative to the viewer. */
export type EdgeName = 'bottom' | 'top' | 'left' | 'right';

export function seatAngle(seat: number | null | undefined): number {
  return SEAT_CARD_ANGLE[seat ?? 0] ?? 0;
}

/** Viewer rotation: how much the world turns so my edge is at the bottom. */
export function viewRotation(mySeat: number | null): number {
  return -seatAngle(mySeat ?? 0);
}

/** Where seat s appears from mySeat's point of view. */
export function relativeEdge(seat: number, mySeat: number | null): EdgeName {
  const angle = (seatAngle(seat) + viewRotation(mySeat) + 360) % 360;
  switch (angle) {
    case 0: return 'bottom';
    case 180: return 'top';
    case 270: return 'right';
    default: return 'left';
  }
}

// ---------------------------------------------------------------------------
// Playmats: one rounded-rect control region per occupied seat.
// ---------------------------------------------------------------------------

export interface MatRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Margin from the table edge to a mat. */
const MAT_MARGIN = 90;
/** Half-size of the neutral center square no mat ever covers (the DMZ). */
const MAT_DMZ = 300;
/** Visual+functional inset per mat, so neighboring mats never touch. */
const MAT_INSET = 14;

/**
 * The mat for a seat, given which seats are occupied. Pinwheel layout,
 * counter-clockwise: every seat always owns the table corner on its
 * front-RIGHT (SE for seat 0, NW for 1, NE for 2, SW for 3), and extends
 * into its front-left corner only when the neighboring seat on that side is
 * empty. Mats therefore never overlap for any occupancy, every player gets
 * the same shape in a full game, and 2-player face-to-face games get
 * full-width mats.
 */
export function matRect(seat: number, occupied: (s: number) => boolean): MatRect {
  const m = MAT_MARGIN;
  const c = TABLE / 2;
  const d = MAT_DMZ;
  const T = TABLE;
  let r: MatRect;
  switch (seat) {
    case 0: r = { x0: occupied(3) ? c - d : m, x1: T - m, y0: c + d, y1: T - m }; break;
    case 1: r = { x0: m, x1: occupied(2) ? c + d : T - m, y0: m, y1: c - d }; break;
    case 2: r = { x0: c + d, x1: T - m, y0: m, y1: occupied(0) ? c + d : T - m }; break;
    default: r = { x0: m, x1: c - d, y0: occupied(1) ? c - d : m, y1: T - m }; break;
  }
  return { x0: r.x0 + MAT_INSET, y0: r.y0 + MAT_INSET, x1: r.x1 - MAT_INSET, y1: r.y1 - MAT_INSET };
}

/** Which occupied seat's mat contains this world point, if any. */
export function matSeatAt(x: number, y: number, seats: number[]): number | null {
  for (const s of seats) {
    const r = matRect(s, (q) => seats.includes(q));
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return s;
  }
  return null;
}

/**
 * Auto-placement slot centers inside a mat, for "Play" without an explicit
 * drop point: row 0 (lands) hugs the seat's own edge, row 1 sits toward the
 * table center. Slots run across the mat's lateral axis; the count adapts to
 * the mat's width, so 2-player mats get more columns than 4-player mats.
 *
 * Returned in FILL order, which staggers out from the middle — the first
 * card lands mid-mat and later ones alternate right/left of it — so a board
 * grows from the center instead of marching in from one end.
 */
export function matSlots(seat: number, mat: MatRect, row: 0 | 1): { x: number; y: number }[] {
  const pad = 28;
  const spacing = CARD_W * 1.15;
  // Distance from the seat's own edge of the mat to the row's card centers.
  // E/W cards sit rotated 90°, so depth always spans the card's HEIGHT.
  const depth = pad + CARD_H / 2 + (row === 0 ? 0 : CARD_H + 36);
  const horizontal = seat === 0 || seat === 1; // lateral axis = x
  const lo = horizontal ? mat.x0 : mat.y0;
  const hi = horizontal ? mat.x1 : mat.y1;
  const n = Math.max(1, Math.floor((hi - lo - pad * 2) / spacing));
  const start = (lo + hi) / 2 - ((n - 1) * spacing) / 2;
  const fixed =
    seat === 0 ? mat.y1 - depth :
    seat === 1 ? mat.y0 + depth :
    seat === 2 ? mat.x1 - depth :
    mat.x0 + depth;
  const at = (i: number) => {
    const lateral = start + i * spacing;
    return horizontal ? { x: lateral, y: fixed } : { x: fixed, y: lateral };
  };
  // Center-out order over the fixed grid: mid, mid+1, mid-1, mid+2, …
  const mid = Math.floor((n - 1) / 2);
  const order: number[] = [];
  for (let step = 0; order.length < n; step++) {
    if (mid + step < n) order.push(mid + step);
    if (step > 0 && mid - step >= 0) order.push(mid - step);
  }
  return order.map(at);
}

export interface ViewTransform {
  k: number;
  theta: number; // degrees
  cx: number;
  cy: number;
}

export function worldToScreen(v: ViewTransform, x: number, y: number): { x: number; y: number } {
  const rad = (v.theta * Math.PI) / 180;
  const dx = x - TABLE / 2;
  const dy = y - TABLE / 2;
  return {
    x: v.cx + v.k * (dx * Math.cos(rad) - dy * Math.sin(rad)),
    y: v.cy + v.k * (dx * Math.sin(rad) + dy * Math.cos(rad)),
  };
}

export function screenToWorld(v: ViewTransform, sx: number, sy: number): { x: number; y: number } {
  const rad = (-v.theta * Math.PI) / 180;
  const dx = (sx - v.cx) / v.k;
  const dy = (sy - v.cy) / v.k;
  return {
    x: TABLE / 2 + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: TABLE / 2 + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

/**
 * Live view shared outside React (Hand drops, cursor math). Battlefield
 * keeps it current on every layout change.
 */
export const liveView: { current: ViewTransform } = {
  current: { k: 0.3, theta: 0, cx: 400, cy: 300 },
};
