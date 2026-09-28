/**
 * This machine's multiplayer identity: an Ed25519 key pair created on first
 * use and kept in ~/.groundcrew/identity.json (readable only by you). The
 * public key is your ID in rooms; the private key never leaves this machine.
 */
import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const IDENTITY_FILE = join(homedir(), '.groundcrew', 'identity.json');

export interface Identity {
  /** Ed25519 public key, base64url (43 chars). */
  publicKey: string;
  /** Sign a UTF-8 string; returns a base64url signature. */
  sign(data: string): string;
}

function fromPrivateKey(privateKey: KeyObject): Identity {
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('not an Ed25519 key');
  return {
    publicKey: jwk.x,
    sign: (data) => sign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64url'),
  };
}

export function loadOrCreateIdentity(file: string = IDENTITY_FILE): Identity {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { privateKey?: string };
    if (saved.privateKey) return fromPrivateKey(createPrivateKey(saved.privateKey));
  } catch {
    // Missing or unreadable: make a new one below.
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ privateKey: pem }, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
  return fromPrivateKey(privateKey);
}
