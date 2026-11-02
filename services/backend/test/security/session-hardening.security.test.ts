import * as crypto from 'crypto';
import { ForbiddenException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { CsrfMiddleware } from '../../src/common/middleware/csrf.middleware';
import { AuthController, pkceMatches } from '../../src/modules/auth/auth.controller';
import { OneTimeStore } from '../../src/modules/auth/one-time-store';

describe('CSRF protection for the cookie session', () => {
  const mw = new CsrfMiddleware();
  const run = (req: any) => {
    const next = jest.fn();
    mw.use({ headers: {}, cookies: {}, ...req } as any, {} as any, next);
    return next;
  };

  it('rejects a cookie-authenticated POST without the header', () => {
    expect(() => run({ method: 'POST', cookies: { op_session: 'jwt' } })).toThrow(ForbiddenException);
  });

  it('accepts a cookie-authenticated POST with the header', () => {
    expect(run({ method: 'POST', cookies: { op_session: 'jwt' }, headers: { 'x-csrf-token': '1' } })).toHaveBeenCalled();
  });

  it('ignores safe methods', () => {
    expect(run({ method: 'GET', cookies: { op_session: 'jwt' } })).toHaveBeenCalled();
  });

  it('does not affect bearer-token clients (mobile)', () => {
    expect(run({ method: 'POST', headers: { authorization: 'Bearer abc' } })).toHaveBeenCalled();
  });

  it('a junk bearer header does not let a cookie request skip the check', () => {
    expect(() => run({ method: 'POST', cookies: { op_session: 'jwt' }, headers: { authorization: 'Bearer' } })).toThrow(
      ForbiddenException,
    );
  });
});

describe('Mobile WorkOS sign-in (PKCE one-time handoff)', () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  function setup() {
    delete process.env.REDIS_URL;
    const store = new OneTimeStore();
    const workos: any = {
      getAuthorizationUrl: jest.fn((state: string) => `https://auth.example/authorize?state=${state}`),
      authenticateWithCode: jest.fn(async () => ({ workosUserId: 'user_1', email: 'a@b.io', emailVerified: true })),
    };
    const auth: any = { loginWithWorkOs: jest.fn(async () => ({ access_token: 'session-jwt' })) };
    const ctrl = new AuthController(auth, workos, store);
    const res: any = { redirect: jest.fn(), cookie: jest.fn(), clearCookie: jest.fn() };
    return { ctrl, res, workos };
  }

  async function signIn(ctrl: AuthController, res: any) {
    const { url } = await ctrl.workosMobileStart({ codeChallenge: challenge });
    const state = new URL(url).searchParams.get('state')!;
    await ctrl.workosCallback({ cookies: {} }, res, 'idp-code', state);
    const redirect: string = res.redirect.mock.calls[0][0];
    expect(redirect.startsWith('openprivy://auth?code=')).toBe(true);
    expect(redirect).not.toContain('session-jwt');
    return new URL(redirect).searchParams.get('code')!;
  }

  it('hands the token to the app only with the right verifier', async () => {
    const { ctrl, res } = setup();
    const code = await signIn(ctrl, res);
    await expect(ctrl.workosMobileExchange({ code, codeVerifier: verifier })).resolves.toEqual({ access_token: 'session-jwt' });
  });

  it('a code works only once', async () => {
    const { ctrl, res } = setup();
    const code = await signIn(ctrl, res);
    await ctrl.workosMobileExchange({ code, codeVerifier: verifier });
    await expect(ctrl.workosMobileExchange({ code, codeVerifier: verifier })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('an intercepted code is useless without the verifier, and is burned by the attempt', async () => {
    const { ctrl, res } = setup();
    const code = await signIn(ctrl, res);
    const attacker = crypto.randomBytes(32).toString('base64url');
    await expect(ctrl.workosMobileExchange({ code, codeVerifier: attacker })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(ctrl.workosMobileExchange({ code, codeVerifier: verifier })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('expired codes are rejected', async () => {
    const { ctrl, res } = setup();
    const now = Date.now();
    const code = await signIn(ctrl, res);
    jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await expect(ctrl.workosMobileExchange({ code, codeVerifier: verifier })).rejects.toBeInstanceOf(UnauthorizedException);
    jest.restoreAllMocks();
  });

  it('a mobile state cannot be replayed into a second login', async () => {
    const { ctrl, res } = setup();
    const { url } = await ctrl.workosMobileStart({ codeChallenge: challenge });
    const state = new URL(url).searchParams.get('state')!;
    await ctrl.workosCallback({ cookies: {} }, res, 'idp-code', state);
    await expect(ctrl.workosCallback({ cookies: {} }, res, 'idp-code-2', state)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a malformed code challenge', async () => {
    const { ctrl } = setup();
    await expect(ctrl.workosMobileStart({ codeChallenge: 'short' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pkceMatches implements RFC 7636 S256 (Appendix B test vector)', () => {
    expect(pkceMatches('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(pkceMatches('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXX', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
  });
});
