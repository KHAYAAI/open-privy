import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';

/**
 * Global module exposing the EncryptionService everywhere it is injected
 * (wallet key custody, key rotation, etc.) without each feature module having
 * to re-declare the provider.
 */
@Global()
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class EncryptionModule {}
