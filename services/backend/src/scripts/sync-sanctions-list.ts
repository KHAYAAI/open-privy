#!/usr/bin/env node
/**
 * Fetches the configured sanctions list (OFAC_SDN_URL, or the documented
 * default) and syncs it into the database. Boots the real DI container so
 * this runs the exact same SanctionsService code the running server uses.
 *
 * Intended to run as a scheduled k8s CronJob
 * (k8s/sanctions-sync-cronjob.yaml) — not exposed as an HTTP route, since
 * there's no admin/operator role yet to scope that to.
 *
 *   node dist/scripts/sync-sanctions-list.js
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SanctionsService } from '../modules/compliance/sanctions.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const sanctionsService = app.get(SanctionsService);
    const { entryCount } = await sanctionsService.fetchAndSync();
    console.log(`SANCTIONS_SYNC_OK entries=${entryCount}`);
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error(`SANCTIONS_SYNC_FAILED error=${(error as Error).message}`);
    await app.close().catch(() => {});
    process.exit(1);
  }
}

main();
