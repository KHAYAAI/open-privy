import { MigrationInterface, QueryRunner } from "typeorm";

export class AddHsmSigningMode1792071271527 implements MigrationInterface {
    name = 'AddHsmSigningMode1792071271527'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "wallets" ADD "signingMode" character varying(20) NOT NULL DEFAULT 'software'`);
        await queryRunner.query(`ALTER TABLE "wallets" ADD "hsmKeyLabel" character varying(255)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "wallets" DROP COLUMN "hsmKeyLabel"`);
        await queryRunner.query(`ALTER TABLE "wallets" DROP COLUMN "signingMode"`);
    }

}
