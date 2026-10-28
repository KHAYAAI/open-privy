import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserOpService } from './userop.service';
import { PaymasterService } from './paymaster.service';
import { AccountAbstractionController } from './account-abstraction.controller';
import { Transaction } from '../transactions/entities/transaction.entity';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { ComplianceModule } from '../compliance/compliance.module';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction]), BlockchainModule, ComplianceModule],
  providers: [UserOpService, PaymasterService],
  controllers: [AccountAbstractionController],
  exports: [UserOpService, PaymasterService],
})
export class AccountAbstractionModule {}
