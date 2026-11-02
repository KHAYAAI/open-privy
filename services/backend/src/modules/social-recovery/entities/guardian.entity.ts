import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type GuardianStatus = 'pending' | 'active' | 'removed';

/** A person the owner trusts to vouch for a recovery. Acts only through emailed one-time links. */
@Entity('guardians')
@Index(['ownerUserId', 'status'])
export class Guardian {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  ownerUserId: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Lowercased. */
  @Column({ type: 'varchar', length: 254 })
  email: string;

  @Column({ type: 'varchar', length: 10, default: 'pending' })
  status: GuardianStatus;

  /** sha256 of the invite token; the token itself only ever exists in the guardian's email. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, nullable: true })
  inviteTokenHash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  inviteExpiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
