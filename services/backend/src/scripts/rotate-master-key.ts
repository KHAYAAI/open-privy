import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { EncryptionService } from '../common/encryption/encryption.service';
import { rotateWallets } from '../common/encryption/key-rotation';

/**
 * Batch master-key rotation. Dry run by default; pass --apply to write.
 *
 * Run with the SAME key configuration the servers use during rotation:
 * new key as ENCRYPTION_MASTER_KEY (current), old key(s) as
 * ENCRYPTION_MASTER_KEY_PREVIOUS, or the equivalent Secrets Manager JSON.
 *
 *   node dist/scripts/rotate-master-key.js            # dry run, writes nothing
 *   node dist/scripts/rotate-master-key.js --apply    # re-encrypt and save
 *
 * Exit codes: 0 = done, nothing failed. 1 = some wallets failed (see report;
 * nothing was written for them). 2 = could not start.
 * Prints SAFE_TO_RETIRE_PREVIOUS_KEYS only when an --apply run finished with
 * zero failures and zero wallets left on an old key.
 */
async function main() {
  const apply = process.argv.includes('--apply');
  const batchArg = process.argv.find((a) => a.startsWith('--batch-size='));
  const batchSize = batchArg ? Number(batchArg.split('=')[1]) : 100;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const encryption = app.get(EncryptionService);
    if (encryption.previousKeyIds.length === 0) {
      console.warn(
        '[rotate] WARNING: no previous keys configured. Rows encrypted under an old key cannot be ' +
          'decrypted and will be reported as failures. Set ENCRYPTION_MASTER_KEY_PREVIOUS.',
      );
    }
    console.log(
      `[rotate] mode=${apply ? 'APPLY' : 'DRY-RUN'} current=${encryption.currentKeyId} ` +
        `previous=[${encryption.previousKeyIds.join(',')}] batch=${batchSize}`,
    );

    const report = await rotateWallets(app.get(DataSource), encryption, {
      apply,
      batchSize,
      log: (m) => console.log(`[rotate] ${m}`),
    });

    console.log(JSON.stringify(report, null, 2));
    if (report.safeToRetirePreviousKeys) console.log('SAFE_TO_RETIRE_PREVIOUS_KEYS');
    process.exitCode = report.failed.length > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(`[rotate] could not run: ${e.message}`);
  process.exit(2);
});
