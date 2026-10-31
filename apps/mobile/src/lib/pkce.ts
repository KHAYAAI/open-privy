/**
 * PKCE (RFC 7636, S256) helpers for the mobile WorkOS sign-in. Pure: the
 * random bytes and SHA-256 come from the caller (expo-crypto in the app,
 * node:crypto in tests).
 */
export function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** 64-char verifier from the RFC 7636 unreserved set, by rejection sampling so every character is equally likely. */
export function verifierFromRandomBytes(bytes: Uint8Array, length = 64): string {
  let out = '';
  const limit = 256 - (256 % VERIFIER_CHARS.length); // 198: reject bytes >= limit
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    if (bytes[i] < limit) out += VERIFIER_CHARS[bytes[i] % VERIFIER_CHARS.length];
  }
  if (out.length < length) throw new Error('not enough random bytes for a PKCE verifier');
  return out;
}

/** Pulls the one-time code out of the app redirect (openprivy://auth?code=...). */
export function codeFromRedirect(url: string, expectedPrefix = 'openprivy://auth'): string | null {
  if (!url.startsWith(expectedPrefix)) return null;
  const query = url.split('?')[1] || '';
  for (const pair of query.split('&')) {
    const [k, v] = pair.split('=');
    if (k === 'code' && v) return decodeURIComponent(v);
  }
  return null;
}
