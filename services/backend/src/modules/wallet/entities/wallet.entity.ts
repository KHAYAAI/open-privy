import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany } from 'typeorm';
import { User } from '../../auth/entities/user.entity';
import { Transaction } from '../../transactions/entities/transaction.entity';

@Entity('wallets')
export class Wallet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => User, (user) => user.wallets)
  user: User;

  @Column({ type: 'varchar', length: 255, unique: true })
  address: string;

  @Column({ type: 'varchar', length: 50 })
  chain: string; // 'ethereum', 'solana', 'polygon'

  @Column({ type: 'varchar', length: 1024, nullable: true })
  publicKey: string;

  // Null for HSM-mode wallets: there is no plaintext key to encrypt — the
  // key material never leaves the hardware token.
  @Column({ type: 'text', nullable: true })
  encryptedPrivateKey: string | null;

  // 'software' (default, AES-256-GCM + per-user key, encryptedPrivateKey
  // populated) or 'hsm' (key generated non-extractable on a PKCS#11 token,
  // referenced by hsmKeyLabel, encryptedPrivateKey left null).
  @Column({ type: 'varchar', length: 20, default: 'software' })
  signingMode: 'software' | 'hsm';

  @Column({ type: 'varchar', length: 255, nullable: true })
  hsmKeyLabel: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  recoveryEmail: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Transaction, (tx) => tx.wallet, { cascade: true })
  transactions: Transaction[];
}
