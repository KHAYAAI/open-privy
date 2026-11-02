import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../auth/decorators/current-user.decorator';
import { SocialRecoveryEnabledGuard } from './social-recovery.enabled.guard';
import { RecoveryService } from './recovery.service';
import { AddGuardianDto, DecisionDto, StartRecoveryDto, TokenDto } from './dto/recovery.dto';

/**
 * Social recovery. Signed-in routes manage your guardians or recover onto
 * your (new) account. Guardian and cancel routes are authenticated by the
 * one-time token from the email, sent in the body (never the URL path) and
 * only ever acted on by POST, so link scanners opening an email do nothing.
 */
@Controller('recovery')
@UseGuards(SocialRecoveryEnabledGuard)
export class SocialRecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Get('guardians')
  @UseGuards(JwtAuthGuard)
  listGuardians(@CurrentUser() user: AuthUser) {
    return this.recovery.listGuardians(user.userId);
  }

  @Post('guardians')
  @UseGuards(JwtAuthGuard)
  addGuardian(@CurrentUser() user: AuthUser, @Body() body: AddGuardianDto) {
    return this.recovery.addGuardian(user.userId, body.name, body.email);
  }

  @Delete('guardians/:id')
  @UseGuards(JwtAuthGuard)
  async removeGuardian(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.recovery.removeGuardian(user.userId, id);
    return { removed: true };
  }

  @Post('guardian-invites/lookup')
  @HttpCode(200)
  describeInvite(@Body() body: TokenDto) {
    return this.recovery.describeInvite(body.token);
  }

  @Post('guardian-invites/confirm')
  @HttpCode(200)
  confirmInvite(@Body() body: TokenDto) {
    return this.recovery.confirmInvite(body.token);
  }

  @Post('requests')
  @HttpCode(202)
  @UseGuards(JwtAuthGuard)
  start(@CurrentUser() user: AuthUser, @Body() body: StartRecoveryDto) {
    return this.recovery.startRequest(user.userId, body.oldAccountEmail);
  }

  @Get('requests/current')
  @UseGuards(JwtAuthGuard)
  current(@CurrentUser() user: AuthUser) {
    return this.recovery.currentRequest(user.userId);
  }

  @Post('requests/cancel')
  @HttpCode(200)
  cancel(@Body() body: TokenDto) {
    return this.recovery.cancelByToken(body.token);
  }

  @Post('approvals/lookup')
  @HttpCode(200)
  describeApproval(@Body() body: TokenDto) {
    return this.recovery.describeApproval(body.token);
  }

  @Post('approvals/decide')
  @HttpCode(200)
  decide(@Body() body: DecisionDto) {
    return this.recovery.decide(body.token, body.decision);
  }
}
