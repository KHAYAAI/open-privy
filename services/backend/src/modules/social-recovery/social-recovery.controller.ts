import { Controller, Get, Post, Delete, Body, Query, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SocialRecoveryEnabledGuard } from './social-recovery.enabled.guard';
import { RecoveryContact } from './entities/recovery-contact.entity';
import { RecoveryGuardian } from './entities/recovery-guardian.entity';
import { SocialRecoveryService } from './social-recovery.service';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

@Controller('recovery')
@UseGuards(JwtAuthGuard, SocialRecoveryEnabledGuard)
export class SocialRecoveryController {
  constructor(private recoveryService: SocialRecoveryService) {}

  @Post('contacts')
  async addRecoveryContact(
    @CurrentUser() user: AuthUser,
    @Body() body: { contactEmail: string; contactName: string },
  ) {
    const contact = await this.recoveryService.addRecoveryContact(
      user.userId,
      body.contactEmail,
      body.contactName,
    );
    return { success: true, contact: toContactView(contact) };
  }

  @Get('contacts')
  async getRecoveryContacts(@CurrentUser() user: AuthUser) {
    const contacts = await this.recoveryService.getRecoveryContacts(user.userId);
    return contacts.map(toContactView);
  }

  @Post('contacts/verify')
  async verifyRecoveryContact(
    @CurrentUser() user: AuthUser,
    @Query('token') token: string,
  ) {
    const contact = await this.recoveryService.verifyRecoveryContact(
      user.userId,
      token,
    );
    return { success: true, contact: toContactView(contact) };
  }

  @Delete('contacts/:contactId')
  async removeRecoveryContact(
    @CurrentUser() user: AuthUser,
    @Param('contactId') contactId: string,
  ) {
    await this.recoveryService.removeRecoveryContact(user.userId, contactId);
    return { success: true };
  }

  @Post('initiate')
  async initiateRecovery(
    @CurrentUser() user: AuthUser,
    @Body() body: { contactIds: string[] },
  ) {
    await this.recoveryService.initiateRecovery(user.userId, body.contactIds);
    return { success: true, message: 'Recovery initiated' };
  }

  @Post('approve')
  async approveRecovery(
    @CurrentUser() user: AuthUser,
    @Query('code') recoveryCode: string,
  ) {
    const guardian = await this.recoveryService.approveRecovery(
      user.userId,
      recoveryCode,
    );
    return { success: true, guardian: toGuardianView(guardian) };
  }

  @Post('complete')
  async completeRecovery(@CurrentUser() user: AuthUser) {
    const result = await this.recoveryService.completeRecovery(user.userId);
    return { success: true, ...result };
  }

  @Get('status')
  async getRecoveryStatus(@CurrentUser() user: AuthUser) {
    const status = await this.recoveryService.getRecoveryStatus(user.userId);
    return status;
  }

  @Get('approvals')
  async getPendingApprovals(@CurrentUser() user: AuthUser) {
    const approvals = await this.recoveryService.getPendingApprovals(user.userId);
    return approvals.map(toGuardianView);
  }
}

/** Public shape of a contact: never includes the email verification token. */
export function toContactView(c: RecoveryContact) {
  return { id: c.id, contactEmail: c.contactEmail, contactName: c.contactName, isVerified: c.isVerified, createdAt: c.createdAt };
}

/** Public shape of a guardian request: never includes the guardian's recovery code. */
export function toGuardianView(g: RecoveryGuardian) {
  return { id: g.id, contactId: g.contactId, hasApproved: g.hasApproved, approvalTimestamp: g.approvalTimestamp ?? null };
}
