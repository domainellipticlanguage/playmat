/**
 * AppSync Events Lambda authorizer. Verifies the room-scoped JWT and — since
 * channel-path authorization is NOT declarative in AppSync Events (§7.1) —
 * enforces that the requested channel belongs to the token's room.
 */
import { verifyRoomToken } from '../../shared/src/jwt';

interface AuthorizerEvent {
  authorizationToken?: string;
  requestContext?: {
    operation?: 'EVENT_CONNECT' | 'EVENT_SUBSCRIBE' | 'EVENT_PUBLISH';
    channelNamespaceName?: string | null;
    channel?: string | null;
  };
}

const JWT_KEY = process.env.JWT_KEY!;

export async function handler(event: AuthorizerEvent) {
  const token = (event.authorizationToken ?? '').replace(/^Bearer\s+/i, '');
  const claims = verifyRoomToken(token, JWT_KEY);
  if (!claims) return { isAuthorized: false };

  const channel = event.requestContext?.channel;
  if (channel) {
    const ok =
      channel === `/state/${claims.rc}` ||
      channel === `/ephemeral/${claims.rc}` ||
      channel.startsWith(`/state/${claims.rc}/`) ||
      channel.startsWith(`/ephemeral/${claims.rc}/`);
    if (!ok) return { isAuthorized: false };
  }

  return {
    isAuthorized: true,
    handlerContext: {
      playerId: claims.pid,
      roomCode: claims.rc,
      spectator: claims.spec ? '1' : '',
    },
    ttlOverride: 300,
  };
}
