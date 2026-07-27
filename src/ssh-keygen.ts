/**
 * Ed25519 SSH key generation on WebCrypto, serialized by hand.
 *
 * WebCrypto can make the key pair but only exports PKCS#8/raw, and OpenSSH
 * reads neither — it wants its own `openssh-key-v1` container. The container
 * is simple enough to assemble here: length-prefixed strings, two check
 * integers, and block padding. `assembleKeyPair` is pure bytes-in/text-out so
 * the format can be pinned by unit tests; only `generateSshKeyPair` touches
 * `crypto`.
 */

const KEY_TYPE = 'ssh-ed25519';
const MAGIC = 'openssh-key-v1\0';

/** The default comment on generated keys; shows up in GitHub's deploy key UI. */
export const SSH_KEY_COMMENT = 'opencode-cloud';

export interface SshKeyPair {
  /** PEM-wrapped `openssh-key-v1` private key. */
  privateKey: string;
  /** One `ssh-ed25519 AAAA… comment` line. */
  publicKey: string;
}

export async function generateSshKeyPair(): Promise<SshKeyPair> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer
  );
  // PKCS#8 for Ed25519 is a fixed 16-byte header followed by the 32-byte seed.
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer
  );
  const seed = pkcs8.slice(pkcs8.length - 32);
  const checkint = new Uint32Array(1);
  crypto.getRandomValues(checkint);
  return assembleKeyPair(publicKey, seed, SSH_KEY_COMMENT, checkint[0]);
}

/**
 * Serialize a raw Ed25519 key pair into OpenSSH's own formats. Deterministic
 * for a given `checkint`, which is what makes the format testable.
 */
export function assembleKeyPair(
  publicKey: Uint8Array,
  seed: Uint8Array,
  comment: string,
  checkint: number
): SshKeyPair {
  if (publicKey.length !== 32 || seed.length !== 32) {
    throw new Error('An Ed25519 key pair is 32 public and 32 seed bytes');
  }
  const publicBlob = concat(sshString(KEY_TYPE), sshBytes(publicKey));

  // The private section: checkint twice, then the key pair, then the comment,
  // padded with 1, 2, 3… to the "none" cipher's 8-byte block size.
  const privateBody = concat(
    sshUint32(checkint),
    sshUint32(checkint),
    sshString(KEY_TYPE),
    sshBytes(publicKey),
    sshBytes(concat(seed, publicKey)),
    sshString(comment)
  );
  const padded = new Uint8Array(
    privateBody.length + ((8 - (privateBody.length % 8)) % 8)
  );
  padded.set(privateBody);
  for (let index = privateBody.length; index < padded.length; index += 1) {
    padded[index] = index - privateBody.length + 1;
  }

  const container = concat(
    new TextEncoder().encode(MAGIC),
    sshString('none'), // cipher
    sshString('none'), // kdf
    sshString(''), // kdf options
    sshUint32(1), // one key
    sshBytes(publicBlob),
    sshBytes(padded)
  );

  return {
    privateKey:
      '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
      wrap(toBase64(container), 70) +
      '\n-----END OPENSSH PRIVATE KEY-----\n',
    publicKey: `${KEY_TYPE} ${toBase64(publicBlob)} ${comment}`
  };
}

function sshUint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

function sshBytes(value: Uint8Array): Uint8Array {
  return concat(sshUint32(value.length), value);
}

function sshString(value: string): Uint8Array {
  return sshBytes(new TextEncoder().encode(value));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function wrap(text: string, width: number): string {
  const lines: string[] = [];
  for (let index = 0; index < text.length; index += width) {
    lines.push(text.slice(index, index + width));
  }
  return lines.join('\n');
}
