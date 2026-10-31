import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { Wallet } from './entities/wallet.entity';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { Pkcs11Service } from '../../common/signing/pkcs11.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Wallet]),
    BlockchainModule,
  ],
  providers: [WalletService, Pkcs11Service],
  controllers: [WalletController],
  exports: [WalletService],
})
export class WalletModule {}
