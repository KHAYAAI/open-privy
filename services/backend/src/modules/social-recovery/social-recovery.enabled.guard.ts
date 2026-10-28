import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

/**
 * Social recovery is off unless ENABLE_SOCIAL_RECOVERY=true. The current
 * guardian flow is not safe to expose: the account owner can verify and
 * approve their own guardians, and completing recovery does not yet restore
 * access. See PRODUCTION_STATUS.md. Responds 404 so the routes are invisible.
 */
@Injectable()
export class SocialRecoveryEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (process.env.ENABLE_SOCIAL_RECOVERY !== 'true') {
      throw new NotFoundException();
    }
    return true;
  }
}
