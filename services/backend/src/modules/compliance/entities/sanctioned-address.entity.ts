import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * A single sanctioned-address record, synced from a sanctions list source
 * (OFAC SDN or equivalent). Matching is case-insensitive and intentionally
 * NOT scoped to a specific chain at lookup time — the safe failure mode for
 * an address reused or mis-tagged across chains is to block it, not to let
 * it through on a technicality.
 */
@Entity('sanctioned_addresses')
@Index(['address'])
export class SanctionedAddress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Always stored lowercase; lookups lowercase their input to match.
  @Column({ type: 'varchar', length: 255 })
  address: string;

  // The asset/chain this address was listed for, where the source specifies
  // one (e.g. 'XBT', 'ETH'). Informational — not used to narrow matching.
  @Column({ type: 'varchar', length: 50, nullable: true })
  currency: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  program: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  sdnEntNum: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  listedName: string | null;

  // Which sync run populated this row — rows from a prior source that
  // weren't refreshed in the latest sync can be identified and pruned.
  @Column({ type: 'varchar', length: 100 })
  source: string;

  @CreateDateColumn()
  createdAt: Date;
}
