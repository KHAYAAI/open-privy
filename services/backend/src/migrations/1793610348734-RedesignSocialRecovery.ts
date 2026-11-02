import { MigrationInterface, QueryRunner } from "typeorm";

export class RedesignSocialRecovery1793610348734 implements MigrationInterface {
    name = 'RedesignSocialRecovery1793610348734'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // The old guardian flow never shipped (disabled behind ENABLE_SOCIAL_RECOVERY) and was unsafe; its tables go.
        await queryRunner.query(`DROP TABLE IF EXISTS "recovery_guardians"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "recovery_contacts"`);
        await queryRunner.query(`CREATE TABLE "guardians" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ownerUserId" uuid NOT NULL, "name" character varying(100) NOT NULL, "email" character varying(254) NOT NULL, "status" character varying(10) NOT NULL DEFAULT 'pending', "inviteTokenHash" character varying(64), "inviteExpiresAt" TIMESTAMP WITH TIME ZONE, "confirmedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3dcf02f3dc96a2c017106f280be" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fbb971744eab7504246b9753c0" ON "guardians" ("inviteTokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_243c18875da0f6c5bad596f4a6" ON "guardians" ("ownerUserId", "status") `);
        await queryRunner.query(`CREATE TABLE "recovery_requests" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "oldUserId" uuid NOT NULL, "newUserId" uuid NOT NULL, "status" character varying(20) NOT NULL, "threshold" integer NOT NULL, "cancelTokenHash" character varying(64) NOT NULL, "approvalsExpireAt" TIMESTAMP WITH TIME ZONE NOT NULL, "unlocksAt" TIMESTAMP WITH TIME ZONE, "closedAt" TIMESTAMP WITH TIME ZONE, "closedReason" character varying(100), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3b0575352da017f21b7819e9089" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3b4af6f08ea0064682a1c670b0" ON "recovery_requests" ("cancelTokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_cb67a10d18fb48a72995e970ac" ON "recovery_requests" ("newUserId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_37c16d93be6e4e4214d7815205" ON "recovery_requests" ("oldUserId", "status") `);
        await queryRunner.query(`CREATE TABLE "recovery_approvals" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "requestId" uuid NOT NULL, "guardianId" uuid NOT NULL, "tokenHash" character varying(64), "decision" character varying(10) NOT NULL DEFAULT 'pending', "decidedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_2566f9bebce865f3ce94ee4a4f3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2372c290459576367422775334" ON "recovery_approvals" ("tokenHash") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_93f1c5ea961df388b0eb53ace4" ON "recovery_approvals" ("requestId", "guardianId") `);
        await queryRunner.query(`ALTER TABLE "users" ADD "lockedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "users" ADD "sessionsValidAfter" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "sessionsValidAfter"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "lockedAt"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_93f1c5ea961df388b0eb53ace4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2372c290459576367422775334"`);
        await queryRunner.query(`DROP TABLE "recovery_approvals"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_37c16d93be6e4e4214d7815205"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cb67a10d18fb48a72995e970ac"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3b4af6f08ea0064682a1c670b0"`);
        await queryRunner.query(`DROP TABLE "recovery_requests"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_243c18875da0f6c5bad596f4a6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fbb971744eab7504246b9753c0"`);
        await queryRunner.query(`DROP TABLE "guardians"`);
        await queryRunner.query(`CREATE TABLE "recovery_contacts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "contactEmail" character varying NOT NULL, "contactName" character varying NOT NULL, "isVerified" boolean NOT NULL DEFAULT false, "verificationToken" character varying, "verificationTokenExpiresAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_598631f975da0bb1d929170d85a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "recovery_guardians" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "contactId" uuid NOT NULL, "hasApproved" boolean NOT NULL DEFAULT false, "approvalTimestamp" TIMESTAMP, "recoveryCode" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4c925653c2b674c163d17a84de3" PRIMARY KEY ("id"))`);
    }

}
