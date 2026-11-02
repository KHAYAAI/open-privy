import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { join } from 'path';
import { User } from './modules/auth/entities/user.entity';
import { Wallet } from './modules/wallet/entities/wallet.entity';
import { Transaction } from './modules/transactions/entities/transaction.entity';
import { AuditLog } from './common/entities/audit-log.entity';
import { Guardian } from './modules/social-recovery/entities/guardian.entity';
import { RecoveryRequest } from './modules/social-recovery/entities/recovery-request.entity';
import { RecoveryApproval } from './modules/social-recovery/entities/recovery-approval.entity';
import { SanctionedAddress } from './modules/compliance/entities/sanctioned-address.entity';
import { ComplianceSyncState } from './modules/compliance/entities/compliance-sync-state.entity';

/**
 * Standalone TypeORM DataSource used by the migration CLI
 * (`npm run migration:generate`, `npm run migration:run`).
 *
 * Production never uses `synchronize` — schema changes go through committed,
 * reviewed migration files applied by a dedicated job (see k8s/migrate-job.yaml).
 */
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [
    User,
    Wallet,
    Transaction,
    AuditLog,
    Guardian,
    RecoveryRequest,
    RecoveryApproval,
    SanctionedAddress,
    ComplianceSyncState,
  ],
  migrations: [join(__dirname, 'migrations/*.{ts,js}')],
  synchronize: false,
  ssl:
    process.env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: false }
      : false,
});
