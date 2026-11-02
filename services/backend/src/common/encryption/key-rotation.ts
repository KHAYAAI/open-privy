import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { DataSource } from 'typeorm';
import { EncryptionService } from './encryption.service';
import { Wallet } from '../../modules/wallet/entities/wallet.entity';

export interface RotationOptions {
  apply: boolean;
  batchSize?: number;
  log?: (msg: string) => void;
}

export interface RotationReport {
  mode: 'dry-run' | 'apply';
  currentKeyId: string;
  scanned: number;
  rotated: number; // apply: written; dry-run: would be written
  failed: Array<{ walletId: string; reason: string }>;
  remainingNotOnCurrentKey: number; // software wallets whose encryptionKeyId != current, after this run
  safeToRetirePreviousKeys: boolean;
}

/**
 * Re-encrypt every software wallet under the CURRENT master key.
 *
 * Preconditions (see docs/DR_RUNBOOK.md, Scenario D): the EncryptionService
 * is configured with the new key as current and the old key(s) as previous,
 * the same configuration the live servers run with during rotation.
 *
 * Per wallet: decrypt with whichever key works, prove the plaintext key
 * derives the wallet's stored address, re-encrypt under the current key,
 * prove the new ciphertext decrypts under the current key ALONE to the same
 * plaintext, then (apply only) write it with an optimistic check that the row
 * was not changed concurrently. Any failure skips that wallet and is reported;
 * nothing is written for it. Idempotent and resumable: rows already tagged
 * with the current key id are skipped.
 */
export async function rotateWallets(
  dataSource: DataSource,
  encryption: EncryptionService,
  opts: RotationOptions,
): Promise<RotationReport> {
  const log = opts.log ?? (() => undefined);
  const batchSize = opts.batchSize ?? 100;
  const currentKeyId = encryption.currentKeyId;
  const repo = dataSource.getRepository(Wallet);

  const report: RotationReport = {
    mode: opts.apply ? 'apply' : 'dry-run',
    currentKeyId,
    scanned: 0,
    rotated: 0,
    failed: [],
    remainingNotOnCurrentKey: 0,
    safeToRetirePreviousKeys: false,
  };

  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const batch = await repo
      .createQueryBuilder('w')
      .where('w.id > :lastId', { lastId })
      .andWhere("w.signingMode = 'software'")
      .andWhere('w.encryptedPrivateKey IS NOT NULL')
      .andWhere('(w.encryptionKeyId IS NULL OR w.encryptionKeyId != :currentKeyId)', { currentKeyId })
      .orderBy('w.id', 'ASC')
      .take(batchSize)
      .getMany();
    if (batch.length === 0) break;

    for (const w of batch) {
      report.scanned++;
      try {
        const { ciphertext, plaintext, fromKeyId } = await encryption.reencryptToCurrentKey(
          w.encryptedPrivateKey!,
          w.userId,
        );
        assertKeyMatchesAddress(w.chain, plaintext, w.address);
        const roundTrip = await encryption.decryptWithCurrentKeyOnly(ciphertext, w.userId);
        if (roundTrip !== plaintext) throw new Error('re-encrypted value does not round-trip');

        if (opts.apply) {
          const res = await repo
            .createQueryBuilder()
            .update(Wallet)
            .set({ encryptedPrivateKey: ciphertext, encryptionKeyId: currentKeyId })
            .where('id = :id AND "encryptedPrivateKey" = :old', { id: w.id, old: w.encryptedPrivateKey })
            .execute();
          if (res.affected !== 1) throw new Error('row changed concurrently; rerun to pick it up');
        }
        report.rotated++;
        log(`${opts.apply ? 'rotated' : 'would rotate'} wallet ${w.id} (${w.chain}) from key ${fromKeyId}`);
      } catch (e) {
        report.failed.push({ walletId: w.id, reason: e.message });
        log(`FAILED wallet ${w.id}: ${e.message}`);
      }
    }
    lastId = batch[batch.length - 1].id;
  }

  report.remainingNotOnCurrentKey = await repo
    .createQueryBuilder('w')
    .where("w.signingMode = 'software'")
    .andWhere('w.encryptedPrivateKey IS NOT NULL')
    .andWhere('(w.encryptionKeyId IS NULL OR w.encryptionKeyId != :currentKeyId)', { currentKeyId })
    .getCount();
  report.safeToRetirePreviousKeys =
    opts.apply && report.failed.length === 0 && report.remainingNotOnCurrentKey === 0;
  return report;
}

/** Proves decrypted key material really belongs to the wallet before anything is rewritten. */
export function assertKeyMatchesAddress(chain: string, plaintext: string, address: string): void {
  switch (chain.toLowerCase()) {
    case 'ethereum':
    case 'polygon':
    case 'arbitrum':
    case 'optimism':
    case 'base': {
      const derived = new ethers.Wallet(plaintext).address;
      if (derived.toLowerCase() !== address.toLowerCase()) {
        throw new Error('decrypted key does not derive the wallet address');
      }
      return;
    }
    case 'solana': {
      const secret = Buffer.from(plaintext, 'hex');
      if (secret.length !== 64) throw new Error('solana secret key must be 64 bytes');
      const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret.subarray(0, 32)]);
      const pub = crypto
        .createPublicKey(crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }))
        .export({ format: 'der', type: 'spki' })
        .subarray(-32);
      if (!pub.equals(secret.subarray(32)) || ethers.encodeBase58(pub) !== address) {
        throw new Error('decrypted key does not derive the wallet address');
      }
      return;
    }
    default:
      throw new Error(`cannot verify key material for chain "${chain}"; refusing to rotate it`);
  }
}
