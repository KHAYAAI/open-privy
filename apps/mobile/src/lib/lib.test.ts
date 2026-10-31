import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { base64ToBase64Url, verifierFromRandomBytes, codeFromRedirect } from './pkce';
import { isTokenUsable, jwtExpiresAt } from './token';
import { validateRecipient, validateAmount, isTrustedAuthUrl } from './validation';

describe('PKCE', () => {
  it('produces a challenge the backend accepts (RFC 7636 Appendix B vector)', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = base64ToBase64Url(crypto.createHash('sha256').update(verifier).digest('base64'));
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('builds a 64-char verifier from the allowed alphabet', () => {
    const v = verifierFromRandomBytes(new Uint8Array(crypto.randomBytes(96)));
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
  });

  it('fails loudly instead of returning a short verifier', () => {
    expect(() => verifierFromRandomBytes(new Uint8Array(10))).toThrow();
  });

  it('only accepts codes from the app redirect', () => {
    expect(codeFromRedirect('openprivy://auth?code=abc%2Bdef')).toBe('abc+def');
    expect(codeFromRedirect('https://evil.example/auth?code=abc')).toBeNull();
    expect(codeFromRedirect('openprivy://auth?error=denied')).toBeNull();
  });
});

describe('session token', () => {
  const sign = (exp: number) => require('jsonwebtoken').sign({ sub: 'u', exp }, 'k');

  it('reads exp and treats expired or nearly expired tokens as unusable', () => {
    const now = Date.now();
    const live = sign(Math.floor(now / 1000) + 3600);
    expect(jwtExpiresAt(live)).toBe((Math.floor(now / 1000) + 3600) * 1000);
    expect(isTokenUsable(live, now)).toBe(true);
    expect(isTokenUsable(sign(Math.floor(now / 1000) + 30), now)).toBe(false);
    expect(isTokenUsable(sign(Math.floor(now / 1000) - 10), now)).toBe(false);
  });

  it('treats garbage as unusable', () => {
    expect(isTokenUsable('not-a-jwt')).toBe(false);
    expect(isTokenUsable(null)).toBe(false);
  });
});

describe('send validation (shared with web)', () => {
  it('accepts a valid address and rejects a checksum typo', () => {
    expect(validateRecipient('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed').ok).toBe(true);
    expect(validateRecipient('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD').ok).toBe(false);
    expect(validateRecipient(ethers.ZeroAddress).ok).toBe(false);
  });

  it('parses amounts exactly and checks the balance', () => {
    const r = validateAmount('0.1');
    expect(r.ok && r.value.wei).toBe(100000000000000000n);
    expect(validateAmount('2', '1.5').ok).toBe(false);
    expect(validateAmount('1e3').ok).toBe(false);
  });

  it('only opens WorkOS sign-in pages', () => {
    expect(isTrustedAuthUrl('https://api.workos.com/user_management/authorize?x')).toBe(true);
    expect(isTrustedAuthUrl('https://api.workos.com.evil.example/x')).toBe(false);
    expect(isTrustedAuthUrl('http://api.workos.com/x')).toBe(false);
  });
});
