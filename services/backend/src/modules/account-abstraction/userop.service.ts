import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ethers } from 'ethers';
import { Transaction } from '../transactions/entities/transaction.entity';
import { EthereumService } from '../blockchain/ethereum.service';
import { SanctionsService } from '../compliance/sanctions.service';
import { PaymasterService } from './paymaster.service';
import { logger } from '../../common/logger';
import {
  PackedUserOp,
  pack128,
  toRpcUserOp,
  extractDestinations,
  encodeExecute,
  DUMMY_SIGNATURE,
} from './userop-format';

export type UserOperation = PackedUserOp;

const ENTRYPOINT_NONCE_ABI = ['function getNonce(address sender, uint192 key) view returns (uint256)'];

@Injectable()
export class UserOpService {
  private bundlerRpc: string;
  private entryPointAddress: string;
  private chainId: number;

  constructor(
    @InjectRepository(Transaction)
    private txRepository: Repository<Transaction>,
    private ethereumService: EthereumService,
    private paymasterService: PaymasterService,
    private sanctionsService: SanctionsService,
  ) {
    this.bundlerRpc = process.env.PIMLICO_ENDPOINT || 'https://api.pimlico.io/v2/ethereum/rpc';
    this.entryPointAddress = process.env.ENTRYPOINT_ADDRESS || '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
    // MUST match the chain the EntryPoint lives on or the userOpHash (and so
    // the signature) will not match on-chain.
    this.chainId = Number(process.env.CHAIN_ID) || 11155111;
  }

  /**
   * Build a UserOp that calls `target` (with `value` wei and inner `callData`)
   * from the smart account, screened and (optionally) sponsored, and return
   * the exact hash the account owner must sign.
   *
   * Sponsorship is attached BEFORE hashing: paymasterAndData is part of the
   * userOpHash, so adding it after the owner signs invalidates the signature.
   */
  async buildUserOp(
    senderAddress: string,
    targetAddress: string,
    callData: string,
    gasLimit?: string,
    options: { value?: bigint; initCode?: string; sponsor?: boolean } = {},
  ): Promise<{ userOp: UserOperation; userOpHash: string }> {
    const value = options.value ?? 0n;
    const accountCallData = encodeExecute(ethers.getAddress(targetAddress), value, callData || '0x');
    await this.assertNotSanctioned(accountCallData);

    const nonce = await this.getNonce(senderAddress);

    const estimatedGas = gasLimit || (await this.ethereumService.estimateGas(targetAddress, callData || '0x'));
    const verificationGasLimit = options.initCode && options.initCode !== '0x' ? 500_000n : 150_000n;
    const callGasLimit = BigInt(estimatedGas) + 50_000n;

    const gasPrice = await this.ethereumService.getGasPrice();
    const maxFeePerGas = gasPrice * 2n;
    const maxPriorityFeePerGas = gasPrice / 2n;

    const userOp: UserOperation = {
      sender: ethers.getAddress(senderAddress),
      nonce: nonce.toString(),
      initCode: options.initCode || '0x',
      callData: accountCallData,
      accountGasLimits: pack128(verificationGasLimit, callGasLimit),
      preVerificationGas: '60000',
      gasFees: pack128(maxPriorityFeePerGas, maxFeePerGas),
      paymasterAndData: '0x',
      signature: DUMMY_SIGNATURE,
    };

    if (options.sponsor !== false) {
      const sponsored = await this.paymasterService.sponsorUserOp(userOp);
      Object.assign(userOp, sponsored);
    }
    userOp.signature = '0x';

    const userOpHash = this.calculateUserOpHash(userOp);
    logger.info(`UserOp built for ${userOp.sender} (nonce ${userOp.nonce})`);
    return { userOp, userOpHash };
  }

  /** Signs with EIP-191 personal_sign, matching SimpleAccount._validateSignature. */
  async signUserOp(userOp: UserOperation, privateKey: string): Promise<string> {
    const wallet = new ethers.Wallet(privateKey);
    const signature = await wallet.signMessage(ethers.getBytes(this.calculateUserOpHash(userOp)));
    userOp.signature = signature;
    return signature;
  }

  async sendUserOp(
    userOp: UserOperation,
    userId: string,
  ): Promise<{ userOpHash: string; status: string }> {
    if (!userOp.signature || userOp.signature === '0x') {
      throw new BadRequestException('UserOp is not signed');
    }
    // Re-screen what is actually being submitted; the client could have
    // changed callData after build-userop.
    await this.assertNotSanctioned(userOp.callData);

    const response = await fetch(this.bundlerRpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_sendUserOperation',
        params: [toRpcUserOp(userOp), this.entryPointAddress],
        id: 1,
      }),
    });
    const data: any = await response.json();
    if (data.error) {
      throw new BadRequestException(`Bundler error: ${data.error.message}`);
    }
    const userOpHash = data.result;

    const tx = this.txRepository.create({
      userId,
      chain: 'ethereum',
      fromAddress: userOp.sender,
      toAddress: extractDestinations(userOp.callData)[0],
      amount: '0',
      status: 'pending',
      metadata: { userOpHash, isAccountAbstraction: true, bundler: 'pimlico' },
    });
    await this.txRepository.save(tx);

    logger.info(`UserOp sent: ${userOpHash}`);
    return { userOpHash, status: 'pending' };
  }

  async getUserOpReceipt(userOpHash: string): Promise<any> {
    const response = await fetch(this.bundlerRpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getUserOperationReceipt',
        params: [userOpHash],
        id: 1,
      }),
    });
    const data: any = await response.json();
    if (data.error) {
      logger.error(`Failed to get UserOp receipt: ${data.error.message}`);
      return null;
    }
    return data.result;
  }

  private async assertNotSanctioned(accountCallData: string): Promise<void> {
    let destinations: string[];
    try {
      destinations = extractDestinations(accountCallData);
    } catch (e) {
      throw new BadRequestException(e.message);
    }
    for (const dest of destinations) {
      const screening = await this.sanctionsService.screenAddress(dest, 'ethereum');
      if (screening.blocked) {
        logger.error(`Blocked UserOp to ${dest}: ${screening.reason}`);
        throw new ForbiddenException(screening.reason || 'Destination address is blocked');
      }
    }
  }

  /**
   * EntryPoint v0.7 owns account nonces (NonceManager); SimpleAccount has no
   * nonce of its own. Key 0 is the default sequential lane. Works for
   * not-yet-deployed (counterfactual) accounts too: it returns 0.
   */
  private async getNonce(address: string): Promise<bigint> {
    const entryPoint = new ethers.Contract(
      this.entryPointAddress,
      ENTRYPOINT_NONCE_ABI,
      this.ethereumService.getProvider(),
    );
    return BigInt(await entryPoint.getNonce(address, 0));
  }

  /**
   * EntryPoint v0.7 userOpHash: keccak(abi.encode(keccak(packedFieldsWithoutSig),
   * entryPoint, chainId)). Verified equal to the real EntryPoint's
   * getUserOpHash in services/contracts/test/SimpleAccount.test.ts and against
   * a deployed EntryPoint in test/integration/userop-hash.integration.test.ts.
   */
  private calculateUserOpHash(userOp: UserOperation): string {
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const hashedOp = ethers.keccak256(
      abi.encode(
        ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
        [
          userOp.sender,
          userOp.nonce,
          ethers.keccak256(userOp.initCode),
          ethers.keccak256(userOp.callData),
          userOp.accountGasLimits,
          userOp.preVerificationGas,
          userOp.gasFees,
          ethers.keccak256(userOp.paymasterAndData),
        ],
      ),
    );
    return ethers.keccak256(
      abi.encode(['bytes32', 'address', 'uint256'], [hashedOp, this.entryPointAddress, this.chainId]),
    );
  }
}
