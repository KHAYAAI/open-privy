import { Module } from '@nestjs/common';
import { SocialRecoveryController } from './social-recovery.controller';
import { RecoveryService } from './recovery.service';
import { NOTIFIER, Notifier, createNotifier } from '../../common/notify/notifier';

/** Email is only required when recovery is on, so a server without SES still boots. */
function notifierFactory(): Notifier {
  if (process.env.ENABLE_SOCIAL_RECOVERY === 'true') return createNotifier();
  return {
    send: async () => {
      throw new Error('Social recovery is disabled; no email provider configured');
    },
  };
}

@Module({
  providers: [RecoveryService, { provide: NOTIFIER, useFactory: notifierFactory }],
  controllers: [SocialRecoveryController],
  exports: [RecoveryService],
})
export class SocialRecoveryModule {}
