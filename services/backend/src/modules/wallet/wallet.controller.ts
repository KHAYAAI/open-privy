import { Controller, Post, Get, Body, Param, UseGuards, Req, Query, ParseUUIDPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WalletService } from './wallet.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { SetRecoveryEmailDto } from './dto/set-recovery-email.dto';

@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private walletService: WalletService) {}

  @Post('create')
  async createWallet(@Req() req: any, @Body() dto: CreateWalletDto) {
    const userId = req.user.userId;
    const wallet = await this.walletService.createWallet(
      userId,
      dto.chain,
      dto.signingMode,
    );
    // Never expose encryptedPrivateKey (or the raw entity) over the API.
    return {
      id: wallet.id,
      address: wallet.address,
      chain: wallet.chain,
      publicKey: wallet.publicKey,
      signingMode: wallet.signingMode,
      createdAt: wallet.createdAt,
    };
  }

  @Get('get')
  async getWallet(@Req() req: any, @Query('chain') chain?: string) {
    const userId = req.user.userId;
    const wallet = await this.walletService.getWallet(userId, chain);
    if (!wallet) {
      return { message: 'No wallet found' };
    }
    return {
      id: wallet.id,
      address: wallet.address,
      chain: wallet.chain,
      createdAt: wallet.createdAt,
    };
  }

  @Get('list')
  async getUserWallets(@Req() req: any) {
    const userId = req.user.userId;
    const wallets = await this.walletService.getUserWallets(userId);
    return wallets.map((w) => ({
      id: w.id,
      address: w.address,
      chain: w.chain,
      createdAt: w.createdAt,
    }));
  }

  @Get(':walletId/balance')
  async getBalance(@Req() req: any, @Param('walletId', new ParseUUIDPipe()) walletId: string) {
    const balance = await this.walletService.getBalance(walletId, req.user.userId);
    return { balance, unit: 'ETH' };
  }

  @Post(':walletId/recovery-email')
  async setRecoveryEmail(
    @Req() req: any,
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Body() body: SetRecoveryEmailDto,
  ) {
    await this.walletService.setRecoveryEmail(walletId, req.user.userId, body.recoveryEmail);
    return { message: 'Recovery email set successfully' };
  }
}
