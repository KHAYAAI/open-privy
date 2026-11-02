import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../../src/modules/auth/auth.service';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { thresholdFor, hashToken, newToken } from '../../src/modules/social-recovery/recovery.service';
import { OutboxNotifier, createNotifier } from '../../src/common/notify/notifier';

/**
 * Social recovery pieces that need no database. The full flow (guardians,
 * approvals, time lock, wallet hand-over, cancel, decline) runs over real
 * HTTP and Postgres in scripts/social-recovery-drill.sh.
 */
describe('Social recovery', () => {
  it('requires a majority of guardians', () => {
    expect([3, 4, 5].map(thresholdFor)).toEqual([2, 3, 3]);
  });

  it('issues 256-bit tokens and stores only their hash', () => {
    const { token, hash } = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
    expect(newToken().token).not.toBe(token);
  });

  describe('sign-in', () => {
    const profile = { workosUserId: 'user_1', email: 'a@b.io', emailVerified: true } as any;
    const make = (user: any) => {
      const repo: any = {
        findOne: jest.fn(async ({ where }: any) => (where.workosUserId === 'user_1' ? user : null)),
        save: jest.fn(async (u: any) => u),
        create: jest.fn((d: any) => d),
      };
      const recovery: any = { cancelForSignIn: jest.fn() };
      const jwt: any = { sign: jest.fn(() => 'jwt') };
      return { svc: new AuthService(repo, jwt, recovery), recovery, jwt };
    };

    it('signing in cancels open recovery requests against the account', async () => {
      const { svc, recovery } = make({ id: 'u1', email: 'a@b.io', workosUserId: 'user_1' });
      await svc.loginWithWorkOs(profile);
      expect(recovery.cancelForSignIn).toHaveBeenCalledWith('u1');
    });

    it('a recovered (locked) account cannot sign in', async () => {
      const { svc, jwt, recovery } = make({ id: 'u1', email: 'a@b.io', workosUserId: 'user_1', lockedAt: new Date() });
      await expect(svc.loginWithWorkOs(profile)).rejects.toThrow('recovered to a new account');
      expect(jwt.sign).not.toHaveBeenCalled();
      expect(recovery.cancelForSignIn).not.toHaveBeenCalled();
    });
  });

  describe('session revocation', () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
    const strategy = (user: any) => new JwtStrategy({ findOne: jest.fn(async () => user) } as any);
    const now = Math.floor(Date.now() / 1000);

    it('accepts a token for an active account', async () => {
      await expect(strategy({ id: 'u1' }).validate({ sub: 'u1', email: 'a', iat: now })).resolves.toEqual({
        userId: 'u1',
        email: 'a',
      });
    });

    it('rejects tokens for locked or deleted accounts', async () => {
      await expect(strategy({ id: 'u1', lockedAt: new Date() }).validate({ sub: 'u1', iat: now })).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(strategy(null).validate({ sub: 'u1', iat: now })).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects tokens issued before sessions were revoked, accepts later ones', async () => {
      const revokedAt = new Date((now - 10) * 1000);
      await expect(strategy({ id: 'u1', sessionsValidAfter: revokedAt }).validate({ sub: 'u1', iat: now - 60 })).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(strategy({ id: 'u1', sessionsValidAfter: revokedAt }).validate({ sub: 'u1', iat: now })).resolves.toBeTruthy();
    });
  });

  describe('email', () => {
    const env = { ...process.env };
    afterEach(() => {
      process.env = { ...env };
    });

    it('the test outbox refuses to run in production (one-time links must not hit disk)', () => {
      process.env.NODE_ENV = 'production';
      expect(() => new OutboxNotifier()).toThrow('tests only');
    });

    it('production defaults to SES and requires a sender address', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.NOTIFIER_PROVIDER;
      delete process.env.MAIL_FROM;
      expect(() => createNotifier()).toThrow('MAIL_FROM');
    });
  });
});
