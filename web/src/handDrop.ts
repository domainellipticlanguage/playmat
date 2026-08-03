/**
 * Live insertion slot in MY hand while a drag hovers the strip (null = pointer
 * is not over the hand). Written by Hand's window-level pointer tracking, read
 * by the drop handlers in Hand and Battlefield — a mutable ref shared outside
 * React, like liveView, because the dragging component holds pointer capture
 * and the strip never sees its own pointer events.
 */
export const handInsert: { index: number | null } = { index: null };
