import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { logger } from '../../common/logger';
import { Transaction } from '../transactions/entities/transaction.entity';
import { PackedUserOp, toRpcUserOp, pack128, unpack128, packPaymasterAndData, DUMMY_SIGNATURE } from './userop-format';

@Injectable()
export class PaymasterService {
  private pimlicoRpc: string;
  private entryPointAddress: string;

  constructor(
    @InjectRepository(Transaction)
    private txRepository: Repository<Transaction>,
  ) {
    this.pimlicoRpc = process.env.PIMLICO_ENDPOINT || 'https://api.pimlico.io/v2/ethereum/rpc';
    this.entryPointAddress = process.env.ENTRYPOINT_ADDRESS || '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
  }

  /**
   * Ask the paymaster (Pimlico, ERC-7677/v0.7 format) to sponsor this op.
   * Returns the packed fields to merge into the op BEFORE it is hashed and
   * signed: paymasterAndData, plus any gas limits the paymaster re-estimated.
   */
  async sponsorUserOp(userOp: PackedUserOp): Promise<Partial<PackedUserOp>> {
    const rpcOp = toRpcUserOp({ ...userOp, paymasterAndData: '0x', signature: DUMMY_SIGNATURE });
    const response = await fetch(this.pimlicoRpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'pm_sponsorUserOperation',
        params: [rpcOp, this.entryPointAddress],
        id: 1,
      }),
    });
    const data: any = await response.json();
    if (data.error) {
      logger.error(`Pimlico sponsorship error: ${data.error.message}`);
      throw new BadRequestException(`Paymaster declined: ${data.error.message}`);
    }
    return PaymasterService.mergeSponsorship(userOp, data.result);
  }

  /** Pure: fold a v0.7 sponsorship result into packed UserOp fields. */
  static mergeSponsorship(userOp: PackedUserOp, r: any): Partial<PackedUserOp> {
    if (!r?.paymaster) {
      throw new BadRequestException('Paymaster returned no sponsorship');
    }
    const [verificationGasLimit, callGasLimit] = unpack128(userOp.accountGasLimits);
    return {
      paymasterAndData: packPaymasterAndData(
        r.paymaster,
        BigInt(r.paymasterVerificationGasLimit ?? 0),
        BigInt(r.paymasterPostOpGasLimit ?? 0),
        r.paymasterData ?? '0x',
      ),
      accountGasLimits: pack128(
        BigInt(r.verificationGasLimit ?? verificationGasLimit),
        BigInt(r.callGasLimit ?? callGasLimit),
      ),
      preVerificationGas: BigInt(r.preVerificationGas ?? userOp.preVerificationGas).toString(),
    };
  }

  async trackGasCost(txHash: string, gasCostWei: string): Promise<void> {
    try {
      await this.txRepository.update(
        { txHash },
        {
          metadata: {
            gasSponsored: true,
            gasCostWei,
            sponsorshipTimestamp: new Date().toISOString(),
          },
        } as any,
      );
    } catch (error) {
      logger.error(`Failed to track gas cost: ${error.message}`);
    }
  }

  async validatePaymasterBalance(): Promise<{ balance: string; sufficient: boolean }> {
    const response = await fetch(this.pimlicoRpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'pimlico_getUserOperationGasPrice', params: [], id: 1 }),
    });
    const data: any = await response.json();
    return { balance: 'managed by Pimlico', sufficient: !data.error };
  }

  /** Upper bound on what the op can cost: all gas limits x maxFeePerGas. */
  async estimateGasCost(userOp: PackedUserOp): Promise<string> {
    return PaymasterService.maxGasCost(userOp).toString();
  }

  static maxGasCost(userOp: PackedUserOp): bigint {
    const [verificationGasLimit, callGasLimit] = unpack128(userOp.accountGasLimits);
    const [, maxFeePerGas] = unpack128(userOp.gasFees);
    let pmGas = 0n;
    if (userOp.paymasterAndData && userOp.paymasterAndData.length >= 2 + 52 * 2) {
      const rpc = toRpcUserOp(userOp);
      pmGas = BigInt(rpc.paymasterVerificationGasLimit ?? 0) + BigInt(rpc.paymasterPostOpGasLimit ?? 0);
    }
    return (verificationGasLimit + callGasLimit + BigInt(userOp.preVerificationGas) + pmGas) * maxFeePerGas;
  }

  async getPaymasterStatus(): Promise<{ active: boolean; network: string; sponsorshipMode: string }> {
    return { active: true, network: 'ethereum', sponsorshipMode: 'pimlico' };
  }
}
