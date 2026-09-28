/**
 * Verify signed room messages with WebCrypto (Ed25519), which exists in
 * modern browsers (secure contexts, e.g. localhost or https) and in Node.
 */
import { base64UrlToBytes, parseSignedContent, type RoomEnvelope, type SignedRoomContent } from './protocol';

// Minimal structural types, so this package needs neither DOM nor Node typings.
type Bytes = Uint8Array<ArrayBuffer>;
type VerifyKey = object;
interface MinimalSubtle {
  importKey(format: 'raw', data: Bytes, algorithm: { name: string }, extractable: boolean, usages: string[]): Promise<VerifyKey>;
  verify(algorithm: { name: string }, key: VerifyKey, signature: Bytes, data: Bytes): Promise<boolean>;
}
interface WebGlobals {
  crypto?: { subtle?: MinimalSubtle };
  TextEncoder: new () => { encode(text: string): Bytes };
}
const web = globalThis as unknown as WebGlobals;

const keyCache = new Map<string, Promise<VerifyKey | null>>();

function subtle(): MinimalSubtle | null {
  return web.crypto?.subtle ?? null;
}

/** True if this runtime can check signatures at all. */
export function canVerifySignatures(): boolean {
  return subtle() !== null;
}

function importKey(key: string): Promise<VerifyKey | null> {
  const cached = keyCache.get(key);
  if (cached) return cached;
  const s = subtle();
  const imported = s
    ? s.importKey('raw', base64UrlToBytes(key), { name: 'Ed25519' }, false, ['verify']).catch(() => null)
    : Promise.resolve(null);
  keyCache.set(key, imported);
  return imported;
}

/**
 * Returns the signed content if the signature is valid for the key it names
 * and the message is for `room`; otherwise null.
 */
export async function verifyRoomEnvelope(envelope: RoomEnvelope, room: string): Promise<SignedRoomContent | null> {
  const content = parseSignedContent(envelope.data);
  if (!content || content.room !== room) return null;
  const key = await importKey(content.key);
  const s = subtle();
  if (!key || !s) return null;
  try {
    const ok = await s.verify(
      { name: 'Ed25519' },
      key,
      base64UrlToBytes(envelope.sig),
      new web.TextEncoder().encode(envelope.data),
    );
    return ok ? content : null;
  } catch {
    return null;
  }
}
