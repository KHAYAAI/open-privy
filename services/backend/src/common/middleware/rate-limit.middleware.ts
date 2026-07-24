import { Injectable, HttpStatus } from '@nestjs/common';
import { NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

/**
 * Rate limiting middleware for protecting against brute force and DoS attacks
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  // NOTE: RateLimiterMemory is per-process/in-memory. Behind multiple replicas
  // each pod keeps its own counters, so limits are per-pod, not global, and
  // reset on restart. For production this should be swapped for
  // RateLimiterRedis (shared store) — tracked as a follow-up. The `blockDuration`
  // option is in SECONDS (the previous `blockDurationMs` key was silently ignored).

  // Global rate limiter: 100 requests per minute per IP
  private rateLimiterByIP = new RateLimiterMemory({
    points: 100,
    duration: 60,
    blockDuration: 300, // 5 minutes block
  });

  // Sensitive endpoints: stricter limits
  private rateLimiterLogin = new RateLimiterMemory({
    points: 5, // 5 attempts
    duration: 60, // per minute
    blockDuration: 900, // 15 minutes block
  });

  private rateLimiterSignup = new RateLimiterMemory({
    points: 3, // 3 signups
    duration: 3600, // per hour
    blockDuration: 3600, // 1 hour block
  });

  use(req: Request, res: Response, next: NextFunction) {
    const ipKey = req.ip || 'unknown';

    // This middleware runs before the auth guard populates req.user, so all
    // limiting is keyed by IP. Per-authenticated-user limits belong at the
    // guard/controller layer where the identity is known.
    this.applyRateLimit(req, res, ipKey)
      .then(() => {
        next();
      })
      .catch((err) => {
        const retryAfter = Math.ceil((err?.msBeforeNext ?? 60000) / 1000);
        res.set('Retry-After', retryAfter.toString());
        res.status(HttpStatus.TOO_MANY_REQUESTS).json({
          statusCode: 429,
          error: 'Too many requests',
          retryAfter,
          message: 'Rate limit exceeded. Please try again later.',
        });
      });
  }

  private async applyRateLimit(
    req: Request,
    res: Response,
    ipKey: string,
  ): Promise<void> {
    // Stricter limits for sensitive endpoints (consumed first so a burst of
    // login/signup attempts is blocked even within the global budget).
    if (this.isSensitiveEndpoint(req)) {
      if (req.path.includes('login')) {
        await this.rateLimiterLogin.consume(ipKey);
      } else if (req.path.includes('signup')) {
        await this.rateLimiterSignup.consume(ipKey);
      }
    }

    // Global rate limit by IP
    const result: RateLimiterRes = await this.rateLimiterByIP.consume(ipKey);

    // Real rate-limit headers derived from the limiter state
    res.set('X-RateLimit-Limit', '100');
    res.set('X-RateLimit-Remaining', result.remainingPoints.toString());
    res.set(
      'X-RateLimit-Reset',
      Math.ceil((Date.now() + result.msBeforeNext) / 1000).toString(),
    );
  }

  private isSensitiveEndpoint(req: Request): boolean {
    const sensitivePatterns = [
      /\/auth\/(login|signup|password)/i,
      /\/wallet\/create/i,
      /\/recovery\/(initiate|approve)/i,
      /\/account-abstraction\/(send|execute)/i,
    ];

    return sensitivePatterns.some((pattern) => pattern.test(req.path));
  }
}

/**
 * Decorator for per-endpoint rate limiting
 */
export function RateLimit(
  points: number = 100,
  duration: number = 60,
  blockDurationMs: number = 300000,
) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;
    const limiter = new RateLimiterMemory({
      points,
      duration,
      blockDuration: Math.ceil(blockDurationMs / 1000), // option is in seconds
    });

    descriptor.value = async function (...args: any[]) {
      const [req, res] = args;
      const key = `${propertyKey}:${req.ip}:${req.user?.id || 'anonymous'}`;

      try {
        await limiter.consume(key);
        return originalMethod.apply(this, args);
      } catch (err) {
        const retryAfter = Math.ceil(err.msBeforeNext / 1000);
        res.set('Retry-After', retryAfter.toString());
        res.status(429).json({
          statusCode: 429,
          error: 'Too many requests',
          message: `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
        });
      }
    };

    return descriptor;
  };
}
