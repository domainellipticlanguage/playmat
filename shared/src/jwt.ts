/**
 * Minimal HS256 JWT — sign/verify with node:crypto, zero dependencies.
 * Used by local-server and the Lambdas. NOT exported from the package index
 * (the browser never signs or verifies; it just carries the token).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface RoomClaims {
  /** room code */
  rc: string;
  /** player id */
  pid: string;
  /** seat number, null for spectators */
  seat: number | null;
  /** spectator flag */
  spec?: boolean;
  iat: number;
  exp: number;
}

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signRoomToken(claims: Omit<RoomClaims, 'iat' | 'exp'>, key: string, ttlSeconds = 7 * 24 * 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const full: RoomClaims = { ...claims, iat: now, exp: now + ttlSeconds };
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify(full)));
  const sig = b64url(createHmac('sha256', key).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

export function verifyRoomToken(token: string, key: string): RoomClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = createHmac('sha256', key).update(`${header}.${payload}`).digest();
  const actual = fromB64url(sig);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(fromB64url(payload).toString()) as RoomClaims;
    if (typeof claims.rc !== 'string' || typeof claims.pid !== 'string') return null;
    if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}
