/**
 * Channel namespace handler for /ephemeral/{roomCode}: cursors, in-flight
 * drags, presence. No data source, nothing persisted — the cheap channel.
 * Spectators may publish here (their cursors are harmless and useful).
 */
import { util } from '@aws-appsync/utils';

function roomScope(ctx) {
  const identity = ctx.identity || {};
  const hc = identity.handlerContext;
  const roomCode = ctx.info.channel.segments[1];
  if (!roomCode) util.unauthorized();
  if (!hc) return { playerId: null }; // IAM caller (backend) — trusted
  if (hc.roomCode !== roomCode) util.unauthorized();
  return { playerId: hc.playerId };
}

export function onPublish(ctx) {
  const scope = roomScope(ctx);
  return ctx.events.filter(
    (e) => e.payload && (scope.playerId === null || e.payload.by === scope.playerId)
  );
}

export function onSubscribe(ctx) {
  roomScope(ctx);
}
