/**
 * This machine's multiplayer identity: an Ed25519 key pair created on first
 * use and kept in ~/.agentnauts/identity.json (readable only by you). The
 * public key is your ID in rooms; the private key never leaves this machine.
 */
import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Everything agentnauts keeps on this computer. */
export const DATA_DIR = join(homedir(), '.agentnauts');
export const IDENTITY_FILE = join(DATA_DIR, 'identity.json');

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

/** This computer's key, if it has one. */
export function loadIdentity(file: string = IDENTITY_FILE): Identity | null {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { privateKey?: string };
    if (saved.privateKey) return fromPrivateKey(createPrivateKey(saved.privateKey));
  } catch {
    // Missing or unreadable.
  }
  return null;
}

export function loadOrCreateIdentity(file: string = IDENTITY_FILE): Identity {
  const existing = loadIdentity(file);
  if (existing) return existing;
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
