import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Tracks the last successful sync per sanctions source, so screening can
 * refuse to evaluate once the data is too stale to mean anything — the same
 * fail-closed posture a sanctions list must have: an outage in the sync job
 * must not silently turn into "nothing is ever blocked."
 */
@Entity('compliance_sync_state')
export class ComplianceSyncState {
  // e.g. 'ofac_sdn' — one row per source.
  @PrimaryColumn({ type: 'varchar', length: 100 })
  source: string;

  @Column({ type: 'timestamp', nullable: true })
  lastSyncedAt: Date | null;

  @Column({ type: 'varchar', length: 20, default: 'never_run' })
  lastSyncStatus: 'ok' | 'failed' | 'never_run';

  @Column({ type: 'int', default: 0 })
  entryCount: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @UpdateDateColumn()
  updatedAt: Date;
}
