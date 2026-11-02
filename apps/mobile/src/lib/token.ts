/** Reads `exp` from a JWT without verifying it (the server verifies; this only avoids using a dead token). */
export function jwtExpiresAt(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = decodeBase64Url(part);
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function isTokenUsable(token: string | null, now = Date.now(), skewMs = 60_000): boolean {
  if (!token) return false;
  const exp = jwtExpiresAt(token);
  return exp !== null && exp - skewMs > now;
}

function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const c of b64) {
    if (c === '=') break;
    const i = chars.indexOf(c);
    if (i < 0) throw new Error('bad base64');
    value = (value << 6) | i;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return decodeURIComponent(escape(out));
}
