import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SanctionsService } from './sanctions.service';
import { ComplianceController } from './compliance.controller';
import { SanctionedAddress } from './entities/sanctioned-address.entity';
import { ComplianceSyncState } from './entities/compliance-sync-state.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SanctionedAddress, ComplianceSyncState])],
  providers: [SanctionsService],
  controllers: [ComplianceController],
  exports: [SanctionsService],
})
export class ComplianceModule {}
