import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

/**
 * Social recovery is off unless ENABLE_SOCIAL_RECOVERY=true, because it
 * needs outbound email (MAIL_FROM + SES in production) to reach guardians
 * and the old account. Responds 404 so the routes are invisible when off.
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
