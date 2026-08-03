/**
 * Password hashing and session tokens, on WebCrypto alone.
 *
 * Everything here is pure of I/O so `node --test` can exercise it directly:
 * the database rows these values live in are written by
 * [access.ts](access.ts) and [api-settings.ts](api-settings.ts).
 */
import type { PasswordRecord } from './settings.ts';

/**
 * Workers cap PBKDF2 at 100,000 iterations — `deriveBits` throws above it —
 * so the ceiling is the setting.
 */
export const PBKDF2_ITERATIONS = 100_000;

const SALT_BYTES = 16;
const HASH_BYTES = 32;
const TOKEN_BYTES = 32;

export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS
): Promise<PasswordRecord> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return {
    algorithm: 'pbkdf2-sha256',
    iterations,
    salt: toBase64(salt),
    hash: toBase64(await derive(password, salt, iterations))
  };
}

export async function verifyPassword(
  record: PasswordRecord,
  password: string
): Promise<boolean> {
  const derived = await derive(password, fromBase64(record.salt), record.iterations);
  return constantTimeEquals(toBase64(derived), record.hash);
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

/**
 * `xxxxx-xxxxx-xxxxx-xxxxx` over an unambiguous lowercase alphabet: four
 * groups of five give ~99 bits, and the shape is easy to read back over a
 * shoulder or a phone.
 */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups: string[] = [];
  for (let group = 0; group < 4; group += 1) {
    let word = '';
    for (let index = 0; index < 5; index += 1) {
      word += alphabet[randomIndex(alphabet.length)];
    }
    groups.push(word);
  }
  return groups.join('-');
}

/** The cookie value: 32 random bytes, base64url so it needs no quoting. */
export function generateSessionToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** What the database stores instead of the token itself. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function randomIndex(length: number): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % length;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
