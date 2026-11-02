import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt, JwtFromRequestFunction } from 'passport-jwt';
import { Request } from 'express';
import { getJwtSecret } from '../../../config/secrets';

/** Read the JWT from the httpOnly session cookie set by the WorkOS callback. */
const fromSessionCookie: JwtFromRequestFunction = (req: Request) => {
  return req?.cookies?.op_session ?? null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {
    super({
      // Accept either an Authorization: Bearer header (API clients / SPA
      // localStorage) or the op_session cookie (WorkOS browser flow).
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        fromSessionCookie,
      ]),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(),
    });
  }

  /**
   * Rejects tokens for accounts that were locked (recovered elsewhere) or
   * whose sessions were revoked after the token was issued.
   */
  async validate(payload: any) {
    const user = await this.users.findOne({
      where: { id: payload.sub },
      select: { id: true, lockedAt: true, sessionsValidAfter: true },
    });
    if (!user || user.lockedAt) throw new UnauthorizedException();
    if (user.sessionsValidAfter && (payload.iat ?? 0) * 1000 < user.sessionsValidAfter.getTime()) {
      throw new UnauthorizedException();
    }
    return { userId: payload.sub, email: payload.email };
  }
}
