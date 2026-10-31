import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SanctionsService } from './sanctions.service';

/**
 * Read-only status only. The sync itself is NOT exposed as an HTTP route:
 * triggering a refresh of a global compliance list isn't something any
 * authenticated end user should be able to invoke, and there's no
 * admin/operator role to scope it to yet. The authoritative sync path is the
 * scheduled k8s CronJob running scripts/sync-sanctions-list.ts
 * (k8s/sanctions-sync-cronjob.yaml) — same pattern as the migration Job.
 */
@Controller('compliance/sanctions')
@UseGuards(JwtAuthGuard)
export class ComplianceController {
  constructor(private sanctionsService: SanctionsService) {}

  @Get('status')
  async getStatus() {
    return this.sanctionsService.getStatus();
  }
}
