import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEncryptionKeyId1793169572412 implements MigrationInterface {
    name = 'AddEncryptionKeyId1793169572412'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "wallets" ADD "encryptionKeyId" character varying(32)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "wallets" DROP COLUMN "encryptionKeyId"`);
    }

}
