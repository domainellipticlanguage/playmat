import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './roomApi';

/** Runtime-agnostic guid (crypto.randomUUID exists in browsers, Node ≥19, and APPSYNC_JS-adjacent lambdas). */
export function newGuid(): string {
  return crypto.randomUUID();
}

export function newRoomCode(): string {
  let code = '';
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
  return code;
}

export function normalizeRoomCode(input: string): string {
  // The alphabet has no 0/O or 1/I/L, so map common lookalikes to nothing
  // sensible exists — codes simply never contain them. Uppercase and keep
  // alphabet characters only.
  return input
    .trim()
    .toUpperCase()
    .split('')
    .filter((c) => ROOM_CODE_ALPHABET.includes(c))
    .join('');
}

/** Fisher–Yates with crypto randomness. Returns a new array. */
export function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
