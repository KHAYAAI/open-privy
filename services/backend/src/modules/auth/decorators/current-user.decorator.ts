import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

export interface AuthUser {
  userId: string;
  email: string;
}

/**
 * Injects the authenticated user (as attached by the JWT strategy):
 * { userId, email }. Throws rather than returning a user without an id,
 * because a missing id passed into a TypeORM `where` is silently dropped and
 * would match every user's rows.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest().user;
  if (!user?.userId || typeof user.userId !== 'string') {
    throw new UnauthorizedException();
  }
  return user;
});
