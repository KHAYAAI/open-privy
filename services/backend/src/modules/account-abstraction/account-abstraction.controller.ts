import { Controller, Post, Get, Body, UseGuards, Req, Param } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserOpService } from './userop.service';
import { PaymasterService } from './paymaster.service';

@Controller('account-abstraction')
@UseGuards(JwtAuthGuard)
export class AccountAbstractionController {
  constructor(
    private userOpService: UserOpService,
    private paymasterService: PaymasterService,
  ) {}

  @Post('build-userop')
  async buildUserOp(
    @Req() req: any,
    @Body()
    body: {
      senderAddress: string;
      targetAddress: string;
      callData?: string;
      value?: string;
      gasLimit?: string;
      initCode?: string;
      sponsor?: boolean;
    },
  ) {
    // senderAddress is the user's smart-account (ERC-4337) address. The op is
    // fully assembled (including sponsorship) before hashing, so the returned
    // userOpHash is final: sign it and pass the op back unchanged.
    const { userOp, userOpHash } = await this.userOpService.buildUserOp(
      body.senderAddress,
      body.targetAddress,
      body.callData || '0x',
      body.gasLimit,
      { value: body.value ? BigInt(body.value) : 0n, initCode: body.initCode, sponsor: body.sponsor },
    );
    return {
      userOp,
      userOpHash,
      message: 'Sign userOpHash (EIP-191 personal_sign) with the account owner key, then call send-userop.',
    };
  }

  @Post('send-userop')
  async sendUserOp(
    @Req() req: any,
    @Body() body: { userOp: any; signature: string },
  ) {
    body.userOp.signature = body.signature;
    const result = await this.userOpService.sendUserOp(body.userOp, req.user.userId);
    return {
      ...result,
      message: 'UserOp submitted to bundler.',
    };
  }

  @Get('userop-status/:userOpHash')
  async getUserOpStatus(@Param('userOpHash') userOpHash: string) {
    const receipt = await this.userOpService.getUserOpReceipt(userOpHash);

    return {
      userOpHash,
      status: receipt ? 'confirmed' : 'pending',
      receipt,
    };
  }

  @Get('paymaster/status')
  async getPaymasterStatus() {
    const status = await this.paymasterService.getPaymasterStatus();
    return status;
  }

  @Post('estimate-gas')
  async estimateGasCost(@Body() body: { userOp: any }) {
    const estimatedCost = await this.paymasterService.estimateGasCost(body.userOp);

    return {
      estimatedGasWei: estimatedCost,
      estimatedGasEth: (Number(estimatedCost) / 1e18).toFixed(6),
      note: 'Upper bound (all gas limits x maxFeePerGas). Paid by the paymaster when sponsored.',
    };
  }

  @Get('paymaster/balance')
  async getPaymasterBalance() {
    const balance = await this.paymasterService.validatePaymasterBalance();
    return balance;
  }
}
