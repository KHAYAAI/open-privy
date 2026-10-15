import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { parse } from 'csv-parse/sync';
import { SanctionedAddress } from './entities/sanctioned-address.entity';
import { ComplianceSyncState } from './entities/compliance-sync-state.entity';
import { logger } from '../../common/logger';

export interface ScreeningResult {
  blocked: boolean;
  reason?: string;
}

interface ParsedEntry {
  address: string;
  currency: string | null;
  program: string | null;
  sdnEntNum: string | null;
  listedName: string | null;
}

const SOURCE = 'ofac_sdn';

/**
 * Sanctions screening for custodial sends.
 *
 * Modeled on the fail-closed posture a real compliance screening service
 * needs: if the list cannot be confirmed fresh, screening refuses to say
 * "clear" rather than silently passing everything through. The schema this
 * parses against is a reasonable, column-name-driven superset of how
 * sanctions-list vendors commonly publish digital-currency address data; it
 * has not been validated against OFAC's live file from this environment
 * (outbound network to that host is not available here) — confirm the exact
 * current column names against the live source before relying on this in
 * production. See docs/SECURITY_AUDIT_BRIEF.md and
 * docs/LICENSING_SCOPING_MEMO.md for the compliance context this serves.
 */
@Injectable()
export class SanctionsService {
  private readonly maxStalenessMs: number;
  private readonly sourceUrl: string;

  constructor(
    @InjectRepository(SanctionedAddress)
    private addressRepository: Repository<SanctionedAddress>,
    @InjectRepository(ComplianceSyncState)
    private syncStateRepository: Repository<ComplianceSyncState>,
  ) {
    const maxAgeHours = Number(process.env.SANCTIONS_MAX_AGE_HOURS) || 168; // 7 days
    this.maxStalenessMs = maxAgeHours * 60 * 60 * 1000;
    this.sourceUrl =
      process.env.OFAC_SDN_URL || 'https://www.treasury.gov/ofac/downloads/sdn.csv';
  }

  /**
   * Screen a destination address before a custodial send signs anything.
   * Fails closed: an unsynced or stale list blocks everything rather than
   * silently permitting it.
   */
  async screenAddress(address: string, _chain: string): Promise<ScreeningResult> {
    const state = await this.syncStateRepository.findOne({ where: { source: SOURCE } });

    if (!state || state.lastSyncStatus !== 'ok' || !state.lastSyncedAt) {
      return {
        blocked: true,
        reason: 'Sanctions list has never synced successfully — refusing to evaluate',
      };
    }

    const ageMs = Date.now() - state.lastSyncedAt.getTime();
    if (ageMs > this.maxStalenessMs) {
      return {
        blocked: true,
        reason: `Sanctions list is stale (last synced ${Math.round(ageMs / 3_600_000)}h ago) — refusing to evaluate`,
      };
    }

    const normalized = address.toLowerCase();
    const match = await this.addressRepository.findOne({ where: { address: normalized } });

    if (match) {
      return {
        blocked: true,
        reason: `Address matches sanctions list entry${match.listedName ? ` (${match.listedName})` : ''}`,
      };
    }

    return { blocked: false };
  }

  async getStatus(): Promise<{
    source: string;
    lastSyncedAt: Date | null;
    lastSyncStatus: string;
    entryCount: number;
    isStale: boolean;
  }> {
    const state = await this.syncStateRepository.findOne({ where: { source: SOURCE } });

    if (!state) {
      return {
        source: SOURCE,
        lastSyncedAt: null,
        lastSyncStatus: 'never_run',
        entryCount: 0,
        isStale: true,
      };
    }

    const isStale =
      !state.lastSyncedAt ||
      state.lastSyncStatus !== 'ok' ||
      Date.now() - state.lastSyncedAt.getTime() > this.maxStalenessMs;

    return {
      source: state.source,
      lastSyncedAt: state.lastSyncedAt,
      lastSyncStatus: state.lastSyncStatus,
      entryCount: state.entryCount,
      isStale,
    };
  }

  /**
   * Parse sanctions-list CSV text into address entries. Column names are
   * matched case-insensitively against a few common aliases rather than
   * fixed positions, so this tolerates minor header variation between
   * publishers without silently misreading columns.
   */
  parseCsv(csvText: string): ParsedEntry[] {
    const records: Record<string, string>[] = parse(csvText, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });

    const pick = (row: Record<string, string>, keys: string[]): string | null => {
      for (const key of keys) {
        const value = row[key];
        if (value && value.trim().length > 0) return value.trim();
      }
      return null;
    };

    const entries: ParsedEntry[] = [];
    for (const row of records) {
      const address = pick(row, ['address', 'digital currency address', 'wallet_address', 'addr']);
      if (!address) continue;

      entries.push({
        address: address.toLowerCase(),
        currency: pick(row, ['currency', 'chain', 'asset']),
        program: pick(row, ['program', 'sanctions_program']),
        sdnEntNum: pick(row, ['ent_num', 'entity_id', 'uid']),
        listedName: pick(row, ['sdn_name', 'name', 'entity_name']),
      });
    }

    return entries;
  }

  /**
   * Replace the stored list with freshly parsed entries and record a
   * successful sync. Intentionally a full replace (not a diff/merge) so a
   * partially-applied previous sync can never leave stale AND fresh rows
   * mixed together with no way to tell which is which.
   */
  async syncFromCsv(csvText: string): Promise<{ entryCount: number }> {
    const entries = this.parseCsv(csvText);

    await this.addressRepository.manager.transaction(async (manager) => {
      await manager.delete(SanctionedAddress, { source: SOURCE });
      if (entries.length > 0) {
        const rows = entries.map((e) =>
          manager.create(SanctionedAddress, { ...e, source: SOURCE }),
        );
        await manager.save(rows);
      }

      await manager.upsert(
        ComplianceSyncState,
        {
          source: SOURCE,
          lastSyncedAt: new Date(),
          lastSyncStatus: 'ok',
          entryCount: entries.length,
          lastError: null,
        },
        ['source'],
      );
    });

    logger.info(`Sanctions list synced: ${entries.length} entries from ${SOURCE}`);
    return { entryCount: entries.length };
  }

  /** Fetch the live list and sync it. Records a failed sync rather than
   * throwing silently, so getStatus()/screenAddress() reflect reality. */
  async fetchAndSync(): Promise<{ entryCount: number }> {
    try {
      const response = await fetch(this.sourceUrl);
      if (!response.ok) {
        throw new Error(`Fetch failed: HTTP ${response.status}`);
      }
      const csvText = await response.text();
      return await this.syncFromCsv(csvText);
    } catch (error) {
      logger.error(`Sanctions sync failed: ${(error as Error).message}`);
      await this.syncStateRepository.upsert(
        {
          source: SOURCE,
          lastSyncStatus: 'failed',
          lastError: (error as Error).message,
        },
        ['source'],
      );
      throw error;
    }
  }
}
