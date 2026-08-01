/**
 * Channel namespace handler for /state/{roomCode}.
 * onPublish persists each event's subject item to the Board table
 * (last-writer-wins, TTL 72h) before broadcasting. APPSYNC_JS runtime.
 *
 * "__BOARD_TABLE__" is substituted with the real table name at synth time
 * (APPSYNC_JS has no environment variables).
 */
import { util } from '@aws-appsync/utils';
import * as ddb from '@aws-appsync/utils/dynamodb';

const TABLE = '__BOARD_TABLE__';

// Keep in sync with shared/src/protocol.ts subjectKey().
// (APPSYNC_JS runtime: no while loops — pad with slice instead.)
function subjectKey(ev) {
  if (ev.t === 'card' && ev.card && ev.card.guid) return 'card#' + ev.card.guid;
  if (ev.t === 'player' && ev.player && ev.player.playerId) return 'player#' + ev.player.playerId;
  if (ev.t === 'pool') return 'pool#' + ev.by + '#' + ev.chunk;
  if (ev.t === 'room') return 'room';
  if (ev.t === 'seats') return 'seats';
  if (ev.t === 'log') {
    const s = ('000000000' + (ev.seq || 0)).slice(-9);
    return 'log#' + s + '#' + ev.by;
  }
  return null;
}

function checkAuth(ctx) {
  const identity = ctx.identity || {};
  const hc = identity.handlerContext;
  const roomCode = ctx.info.channel.segments[1];
  if (!roomCode) util.unauthorized();
  if (!hc) {
    // No handlerContext => IAM caller => our own room Lambda. Trusted.
    return { server: true, roomCode };
  }
  if (hc.roomCode !== roomCode) util.unauthorized();
  return { server: false, roomCode, playerId: hc.playerId, spectator: hc.spectator === '1' };
}

export const onPublish = {
  request(ctx) {
    const auth = checkAuth(ctx);
    if (!auth.server && auth.spectator) util.unauthorized();
    const expireAt = util.time.nowEpochSeconds() + 259200; // 72h sliding
    const items = [];
    const validIds = [];
    for (const e of ctx.events) {
      const ev = e.payload;
      // S-3: players may only publish events attributed to themselves.
      const attributed = ev && ev.t && (auth.server || ev.by === auth.playerId);
      const sk = attributed ? subjectKey(ev) : null;
      if (sk) {
        items.push({
          roomCode: auth.roomCode,
          sk: sk,
          seq: ev.seq || 0,
          by: ev.by || '',
          g: ev.g || '',
          t: ev.t,
          ev: ev,
          expireAt: expireAt,
        });
        validIds.push(e.id);
      }
    }
    ctx.stash.validIds = validIds;
    if (items.length === 0) {
      // Every event was misattributed (S-3) — reject the publish outright.
      util.error('No publishable events (attribution mismatch)');
    }
    const tables = {};
    tables[TABLE] = items;
    return ddb.batchPut({ tables: tables });
  },
  response(ctx) {
    const validIds = ctx.stash.validIds || [];
    return ctx.events.filter((e) => validIds.indexOf(e.id) >= 0);
  },
};

export function onSubscribe(ctx) {
  checkAuth(ctx);
}
