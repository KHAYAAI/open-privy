import {
  Controller,
  Post,
  Body,
  HttpCode,
  UseGuards,
  Get,
  Req,
  Res,
  Query,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import * as crypto from 'crypto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import { WorkOsService } from './workos.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { OneTimeStore } from './one-time-store';

const SESSION_COOKIE = 'op_session';
const STATE_COOKIE = 'op_oauth_state';
const MOBILE_STATE_TTL_S = 10 * 60;
const MOBILE_CODE_TTL_S = 60;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

/** RFC 7636 S256: base64url(sha256(verifier)), compared in constant time. */
export function pkceMatches(codeVerifier: string, codeChallenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier || '')) return false;
  const computed = Buffer.from(crypto.createHash('sha256').update(codeVerifier).digest('base64url'));
  const expected = Buffer.from(codeChallenge || '');
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

function cookieSecure(): boolean {
  return (
    process.env.SESSION_COOKIE_SECURE === 'true' ||
    process.env.NODE_ENV === 'production'
  );
}

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private workosService: WorkOsService,
    private oneTimeStore: OneTimeStore,
  ) {}

  @Post('signup')
  @HttpCode(201)
  async signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  // ---- WorkOS AuthKit (SSO / email / social) --------------------------------

  /**
   * Start the AuthKit login. Returns the hosted-login URL for the SPA to send
   * the browser to, and sets a short-lived state cookie for CSRF protection.
   */
  @Get('workos/authorize')
  async workosAuthorize(
    @Res({ passthrough: true }) res: Response,
    @Query('organization_id') organizationId?: string,
  ) {
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes
      path: '/',
    });

    const url = this.workosService.getAuthorizationUrl(state, organizationId);
    return { url };
  }

  /**
   * AuthKit redirects here with an authorization code. We validate state,
   * exchange the code for the user profile, mint our own JWT, drop it in an
   * httpOnly session cookie, and bounce the browser back to the app.
   */
  @Get('workos/callback')
  async workosCallback(
    @Req() req: any,
    @Res() res: Response,
    @Query('code') code: string,
    @Query('state') state: string,
  ) {
    if (!code || !state) {
      throw new UnauthorizedException('Invalid OAuth state or missing code');
    }

    // Mobile sign-in: the state was minted by /workos/mobile/start and is
    // bound to the app's PKCE challenge. Hand the app a one-time code via its
    // redirect scheme; the token itself never appears in a URL.
    const mobileChallenge = await this.oneTimeStore.take(`mstate:${state}`);
    if (mobileChallenge) {
      const profile = await this.workosService.authenticateWithCode(code);
      const { access_token } = await this.authService.loginWithWorkOs(profile);
      const handoff = crypto.randomBytes(32).toString('base64url');
      await this.oneTimeStore.put(
        `mcode:${handoff}`,
        JSON.stringify({ token: access_token, challenge: mobileChallenge }),
        MOBILE_CODE_TTL_S,
      );
      const appRedirect = process.env.MOBILE_AUTH_REDIRECT_URI || 'openprivy://auth';
      return res.redirect(`${appRedirect}?code=${encodeURIComponent(handoff)}`);
    }

    const expectedState = req.cookies?.[STATE_COOKIE];
    if (!expectedState || state !== expectedState) {
      throw new UnauthorizedException('Invalid OAuth state or missing code');
    }
    res.clearCookie(STATE_COOKIE, { path: '/' });

    const profile = await this.workosService.authenticateWithCode(code);
    const { access_token } = await this.authService.loginWithWorkOs(profile);

    res.cookie(SESSION_COOKIE, access_token, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24h, matches JWT expiry
      path: '/',
    });

    const redirectTo =
      process.env.WORKOS_POST_LOGIN_REDIRECT || 'http://localhost:3000/dashboard';
    return res.redirect(redirectTo);
  }

  /**
   * Mobile sign-in, step 1. The app sends a PKCE S256 code challenge and opens
   * the returned URL in the system browser.
   */
  @Post('workos/mobile/start')
  @HttpCode(200)
  async workosMobileStart(
    @Body() body: { codeChallenge: string; organizationId?: string },
  ) {
    if (!BASE64URL_43.test(body?.codeChallenge || '')) {
      throw new BadRequestException('codeChallenge must be a base64url SHA-256 (43 chars)');
    }
    const state = crypto.randomBytes(16).toString('hex');
    const url = this.workosService.getAuthorizationUrl(state, body.organizationId);
    await this.oneTimeStore.put(`mstate:${state}`, body.codeChallenge, MOBILE_STATE_TTL_S);
    return { url };
  }

  /**
   * Mobile sign-in, step 2. Redeem the one-time code from the redirect,
   * proving possession of the PKCE verifier, for the session token. Each
   * code works once, within 60 seconds, and only with the right verifier, so
   * another app that intercepts the redirect cannot use it.
   */
  @Post('workos/mobile/exchange')
  @HttpCode(200)
  async workosMobileExchange(@Body() body: { code: string; codeVerifier: string }) {
    const stored = body?.code ? await this.oneTimeStore.take(`mcode:${body.code}`) : null;
    if (!stored) {
      throw new UnauthorizedException('Sign-in code is invalid, expired or already used');
    }
    const { token, challenge } = JSON.parse(stored);
    if (!pkceMatches(body.codeVerifier, challenge)) {
      throw new UnauthorizedException('Sign-in code is invalid, expired or already used');
    }
    return { access_token: token };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Req() req: any) {
    const user = await this.authService.validateUser(req.user.userId);
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { message: 'Logged out successfully' };
  }
}
