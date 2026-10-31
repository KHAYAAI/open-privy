#!/usr/bin/env node
/**
 * Recovery-drill verification step.
 *
 * Boots the REAL NestJS DI container (no HTTP listener) so this exercises the
 * exact same EncryptionService + WalletService code the running server uses —
 * no duplicated crypto logic that could independently "agree" with itself.
 *
 * Given a wallet id + owning user id, it:
 *   1. Decrypts the stored private key via WalletService.getDecryptedPrivateKey
 *   2. Signs a fixed message with it
 *   3. Verifies the signature recovers the wallet's stored on-chain address
 *
 * Exit 0 + "RECOVERY_OK" on success, exit 1 + "RECOVERY_FAILED" on any
 * decryption/verification failure. Used by scripts/recovery-drill.sh both as
 * the positive case (correct master key, after a simulated process kill +
 * restart) and the negative case (wrong master key, which MUST fail — proving
 * the drill isn't vacuously true).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ethers } from 'ethers';
import { AppModule } from '../app.module';
import { WalletService } from '../modules/wallet/wallet.service';

const DRILL_MESSAGE = 'openprivy-recovery-drill';

async function main() {
  const walletId = process.env.DRILL_WALLET_ID;
  const userId = process.env.DRILL_USER_ID;
  const expectedAddress = process.env.DRILL_EXPECTED_ADDRESS;

  if (!walletId || !userId || !expectedAddress) {
    console.error('Set DRILL_WALLET_ID, DRILL_USER_ID, DRILL_EXPECTED_ADDRESS');
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const walletService = app.get(WalletService);
    const privateKey = await walletService.getDecryptedPrivateKey(walletId, userId);

    const signer = new ethers.Wallet(privateKey);
    const signature = await signer.signMessage(DRILL_MESSAGE);
    const recovered = ethers.verifyMessage(DRILL_MESSAGE, signature);

    if (recovered.toLowerCase() === expectedAddress.toLowerCase()) {
      console.log(`RECOVERY_OK recovered=${recovered}`);
      await app.close();
      process.exit(0);
    } else {
      console.error(`RECOVERY_FAILED mismatch recovered=${recovered} expected=${expectedAddress}`);
      await app.close();
      process.exit(1);
    }
  } catch (error) {
    console.error(`RECOVERY_FAILED error=${(error as Error).message}`);
    await app.close().catch(() => {});
    process.exit(1);
  }
}

main();
