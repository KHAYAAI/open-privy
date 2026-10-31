import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SanctionsService } from '../../src/modules/compliance/sanctions.service';
import { SanctionedAddress } from '../../src/modules/compliance/entities/sanctioned-address.entity';
import { ComplianceSyncState } from '../../src/modules/compliance/entities/compliance-sync-state.entity';

/**
 * SYNTHETIC test fixture only — not real sanctions data. Modeled on common
 * digital-currency-address list column conventions; the exact live OFAC
 * schema should be confirmed before go-live (see sanctions.service.ts).
 */
const FIXTURE_CSV = `ent_num,SDN_Name,Program,Currency,Address
10001,TOTALLY FAKE SANCTIONED CORP,SDN,ETH,0xDeAdBeEf00000000000000000000000000000001
10002,ANOTHER FAKE ENTITY,SDN,XBT,bc1qexamplefakeaddressfortestingonly0000
`;

describe('SanctionsService', () => {
  let service: SanctionsService;
  let addresses: Record<string, any>[];
  let syncState: Record<string, any> | null;

  // Real TypeORM repositories backed by the same connection share ONE
  // EntityManager — manager.transaction()'s callback can touch any entity.
  // A mock manager scoped to a single repository's own store (rather than
  // dispatching by entity, like the real one does) silently misroutes writes
  // for the OTHER entity — exactly the bug this shared-manager mock avoids.
  function makeSharedManager(storesByEntity: Map<any, { rows: any[] }>) {
    const storeFor = (entity: any) => {
      const store = storesByEntity.get(entity);
      if (!store) throw new Error(`No mock store registered for entity ${entity?.name}`);
      return store;
    };
    const ENTITY_TAG = Symbol('entity');
    const manager = {
      delete: async (entity: any, criteria: any) => {
        const store = storeFor(entity);
        const key = Object.keys(criteria)[0];
        store.rows = store.rows.filter((r) => r[key] !== criteria[key]);
      },
      // Mirrors real TypeORM: create() tags the instance with its entity so
      // a later save(rows) — called WITHOUT an explicit entity, exactly as
      // the service does — can still be routed to the right table.
      create: (entity: any, data: any) => ({ ...data, [ENTITY_TAG]: entity }),
      save: async (rowsOrEntity: any, maybeRows?: any) => {
        const twoArgForm = maybeRows !== undefined;
        const rows = twoArgForm
          ? Array.isArray(maybeRows) ? maybeRows : [maybeRows]
          : Array.isArray(rowsOrEntity) ? rowsOrEntity : [rowsOrEntity];
        const entity = twoArgForm ? rowsOrEntity : rows[0]?.[ENTITY_TAG];
        const store = storeFor(entity);
        store.rows.push(...rows);
      },
      upsert: async (entity: any, data: any, conflictPaths: string[]) => {
        const store = storeFor(entity);
        const key = conflictPaths[0];
        const idx = store.rows.findIndex((r) => r[key] === data[key]);
        if (idx >= 0) store.rows[idx] = { ...store.rows[idx], ...data };
        else store.rows.push(data);
      },
      transaction: async (fn: any) => fn(manager),
    };
    return manager;
  }

  function makeInMemoryRepo<T extends Record<string, any>>(
    store: { rows: T[] },
    sharedManager: any,
  ) {
    return {
      findOne: jest.fn(async ({ where }: any) => {
        const key = Object.keys(where)[0];
        return store.rows.find((r) => r[key] === where[key]) ?? null;
      }),
      create: jest.fn((data: any) => ({ ...data })),
      save: jest.fn(async (rowsOrRow: any) => {
        const rows = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
        store.rows.push(...rows);
        return rowsOrRow;
      }),
      delete: jest.fn(async (criteria: any) => {
        const key = Object.keys(criteria)[0];
        store.rows = store.rows.filter((r) => r[key] !== criteria[key]) as T[];
      }),
      upsert: jest.fn(async (data: any, conflictPaths: string[]) => {
        const key = conflictPaths[0];
        const idx = store.rows.findIndex((r) => r[key] === data[key]);
        if (idx >= 0) store.rows[idx] = { ...store.rows[idx], ...data };
        else store.rows.push(data as T);
      }),
      manager: sharedManager,
    };
  }

  beforeEach(async () => {
    const addressStore = { rows: [] as any[] };
    const syncStore = { rows: [] as any[] };
    const sharedManager = makeSharedManager(
      new Map<any, { rows: any[] }>([
        [SanctionedAddress, addressStore],
        [ComplianceSyncState, syncStore],
      ]),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SanctionsService,
        {
          provide: getRepositoryToken(SanctionedAddress),
          useValue: makeInMemoryRepo(addressStore, sharedManager),
        },
        {
          provide: getRepositoryToken(ComplianceSyncState),
          useValue: makeInMemoryRepo(syncStore, sharedManager),
        },
      ],
    }).compile();

    service = module.get(SanctionsService);
    addresses = addressStore.rows;
    syncState = null;
  });

  describe('parseCsv', () => {
    it('extracts entries from the fixture, matching columns case-insensitively', () => {
      const entries = service.parseCsv(FIXTURE_CSV);
      expect(entries).toHaveLength(2);
      expect(entries[0].address).toBe('0xdeadbeef00000000000000000000000000000001');
      expect(entries[0].listedName).toBe('TOTALLY FAKE SANCTIONED CORP');
      expect(entries[0].currency).toBe('ETH');
      expect(entries[1].currency).toBe('XBT');
    });

    it('skips rows with no address column populated', () => {
      const csv = 'ent_num,SDN_Name,Program\n1,No Address Here,SDN\n';
      expect(service.parseCsv(csv)).toHaveLength(0);
    });
  });

  describe('screenAddress — fail-closed behaviour', () => {
    it('blocks everything when the list has never synced', async () => {
      const result = await service.screenAddress('0x1234', 'ethereum');
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/never synced/i);
    });

    it('blocks everything when the last sync failed', async () => {
      await service.syncFromCsv(FIXTURE_CSV);
      // Simulate a failed refresh overwriting sync state.
      const state = addresses; // not used; mutate syncState store directly via service
      await (service as any).syncStateRepository.upsert(
        { source: 'ofac_sdn', lastSyncStatus: 'failed', lastError: 'boom' },
        ['source'],
      );
      const result = await service.screenAddress(
        '0xdeadbeef00000000000000000000000000000001',
        'ethereum',
      );
      expect(result.blocked).toBe(true);
    });

    it('blocks everything when the list is stale, even for a clean address', async () => {
      await service.syncFromCsv(FIXTURE_CSV);
      // Force the sync timestamp into the past beyond the staleness window.
      await (service as any).syncStateRepository.upsert(
        { source: 'ofac_sdn', lastSyncedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30), lastSyncStatus: 'ok' },
        ['source'],
      );
      const result = await service.screenAddress('0x0000000000000000000000000000000000beef', 'ethereum');
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/stale/i);
    });
  });

  describe('screenAddress — after a fresh sync', () => {
    beforeEach(async () => {
      await service.syncFromCsv(FIXTURE_CSV);
    });

    it('blocks an address that matches the list (case-insensitive)', async () => {
      const result = await service.screenAddress(
        '0xDEADBEEF00000000000000000000000000000001',
        'ethereum',
      );
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('TOTALLY FAKE SANCTIONED CORP');
    });

    it('allows a clean address through', async () => {
      const result = await service.screenAddress(
        '0x000000000000000000000000000000000000ff',
        'ethereum',
      );
      expect(result.blocked).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('reports never_run before any sync', async () => {
      const status = await service.getStatus();
      expect(status.isStale).toBe(true);
      expect(status.lastSyncStatus).toBe('never_run');
    });

    it('reports fresh + entry count right after a sync', async () => {
      await service.syncFromCsv(FIXTURE_CSV);
      const status = await service.getStatus();
      expect(status.isStale).toBe(false);
      expect(status.entryCount).toBe(2);
    });
  });
});
