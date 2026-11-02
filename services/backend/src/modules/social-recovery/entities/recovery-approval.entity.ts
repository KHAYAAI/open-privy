import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type ApprovalDecision = 'pending' | 'approved' | 'declined';

/** One guardian's vote on one request, cast through a single-use emailed link. */
@Entity('recovery_approvals')
@Index(['requestId', 'guardianId'], { unique: true })
export class RecoveryApproval {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  requestId: string;

  @Column('uuid')
  guardianId: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, nullable: true })
  tokenHash: string | null;

  @Column({ type: 'varchar', length: 10, default: 'pending' })
  decision: ApprovalDecision;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;
}
