import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defense for the cookie session (op_session).
 *
 * A state-changing request that authenticates by cookie must carry a custom
 * X-CSRF-Token header. Browsers only let another origin add custom headers
 * after a CORS preflight, which this API grants only to CORS_ORIGINS, so a
 * forged form post or fetch from any other site (including a sibling
 * subdomain, which SameSite=Lax would not stop) is rejected.
 *
 * Bearer-token requests (mobile, API clients) are not cookie-borne and are
 * unaffected.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    if (SAFE_METHODS.has(req.method)) return next();
    const usesCookie = Boolean((req as any).cookies?.op_session);
    const usesBearer = /^Bearer\s+\S+/i.test(req.headers.authorization || '');
    if (usesCookie && !usesBearer && !req.headers[CSRF_HEADER]) {
      throw new ForbiddenException('Missing X-CSRF-Token header');
    }
    next();
  }
}
