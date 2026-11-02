import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type RecoveryStatus =
  | 'awaiting_approvals'
  | 'time_locked'
  | 'completing'
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'expired';

export const OPEN_STATUSES: RecoveryStatus[] = ['awaiting_approvals', 'time_locked', 'completing'];

/** A claim, by a new account, to take over an old account's custodial wallets. */
@Entity('recovery_requests')
@Index(['oldUserId', 'status'])
@Index(['newUserId', 'status'])
export class RecoveryRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  oldUserId: string;

  @Column('uuid')
  newUserId: string;

  @Column({ type: 'varchar', length: 20 })
  status: RecoveryStatus;

  @Column('int')
  threshold: number;

  /** sha256 of the token in the "this wasn't me" link sent to the old account. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  cancelTokenHash: string;

  /** Guardians must reach the threshold before this. */
  @Column({ type: 'timestamptz' })
  approvalsExpireAt: Date;

  /** Set when the threshold is met: wallets move after this unless cancelled. */
  @Column({ type: 'timestamptz', nullable: true })
  unlocksAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  closedReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
