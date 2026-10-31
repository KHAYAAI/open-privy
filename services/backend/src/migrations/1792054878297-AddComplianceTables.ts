import { MigrationInterface, QueryRunner } from "typeorm";

export class AddComplianceTables1792054878297 implements MigrationInterface {
    name = 'AddComplianceTables1792054878297'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "sanctioned_addresses" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "address" character varying(255) NOT NULL, "currency" character varying(50), "program" character varying(100), "sdnEntNum" character varying(50), "listedName" character varying(512), "source" character varying(100) NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_31e26f85481f29d0f61dc36c9d2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_501b190aa45d01aee4cdb59828" ON "sanctioned_addresses" ("address") `);
        await queryRunner.query(`CREATE TABLE "compliance_sync_state" ("source" character varying(100) NOT NULL, "lastSyncedAt" TIMESTAMP, "lastSyncStatus" character varying(20) NOT NULL DEFAULT 'never_run', "entryCount" integer NOT NULL DEFAULT '0', "lastError" text, "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_3e429f16070ffd13db85141ff8d" PRIMARY KEY ("source"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "compliance_sync_state"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_501b190aa45d01aee4cdb59828"`);
        await queryRunner.query(`DROP TABLE "sanctioned_addresses"`);
    }

}
