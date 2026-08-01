/**
 * Table geometry. World coordinates are fixed (README §Other thoughts):
 * seat 0's home edge is south. Every client renders the same world rotated
 * so THEIR edge is at the bottom, as a final affine step.
 */

/** World is a TABLE x TABLE square. */
export const TABLE = 2400;
/** Card width in world units (height = ratio 1.4). */
export const CARD_W = 100;
export const CARD_H = 140;

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

/** Home battlefield drop position for a seat (in front of their edge). */
export function homePosition(seat: number, slot = 0): { x: number; y: number } {
  const c = TABLE / 2;
  const depth = TABLE * 0.30; // distance from center toward the seat's edge
  const lateral = (slot % 7 - 3) * (CARD_W * 1.2);
  switch (seat) {
    case 0: return { x: c + lateral, y: c + depth };
    case 1: return { x: c - lateral, y: c - depth };
    case 2: return { x: c + depth, y: c + lateral };
    default: return { x: c - depth, y: c - lateral };
  }
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
