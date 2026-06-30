import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ethers } from 'ethers';
import { Wallet } from './entities/wallet.entity';
import { EthereumService } from '../blockchain/ethereum.service';
import { logger } from '../../common/logger';
import * as crypto from 'crypto';

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(Wallet)
    private walletRepository: Repository<Wallet>,
    private ethereumService: EthereumService,
  ) {}

  async createWallet(userId: string, chain: string): Promise<Wallet> {
    try {
      // Check if wallet already exists for this chain
      const existing = await this.walletRepository.findOne({
        where: { userId, chain },
      });

      if (existing) {
        throw new BadRequestException(
          `Wallet already exists for chain ${chain}`,
        );
      }

      // Generate new ethers.js wallet (works for Ethereum-compatible chains)
      const ethersWallet = ethers.Wallet.createRandom();

      // Encrypt private key (simple encryption; use KMS in production)
      const encryptionKey = process.env.ENCRYPTION_KEY || 'dev-secret-key';
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(
        'aes-256-cbc',
        Buffer.from(encryptionKey.padEnd(32).substring(0, 32)),
        iv,
      );
      let encrypted = cipher.update(ethersWallet.privateKey, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const encryptedPrivateKey = iv.toString('hex') + ':' + encrypted;

      // Create wallet record
      const wallet = this.walletRepository.create({
        userId,
        address: ethersWallet.address,
        chain,
        publicKey: ethersWallet.publicKey,
        encryptedPrivateKey,
        recoveryEmail: null,
        isActive: true,
      });

      await this.walletRepository.save(wallet);

      logger.info(`Wallet created for user ${userId} on chain ${chain}`);

      return wallet;
    } catch (error) {
      logger.error(`Failed to create wallet: ${error.message}`);
      throw error;
    }
  }

  async getWallet(userId: string, chain?: string): Promise<Wallet | null> {
    const query = this.walletRepository.createQueryBuilder('wallet').where('wallet.userId = :userId', { userId });

    if (chain) {
      query.andWhere('wallet.chain = :chain', { chain });
    }

    return query.getOne();
  }

  async getWalletById(walletId: string): Promise<Wallet> {
    const wallet = await this.walletRepository.findOne({ where: { id: walletId } });
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    return wallet;
  }

  async getUserWallets(userId: string): Promise<Wallet[]> {
    return this.walletRepository.find({ where: { userId, isActive: true } });
  }

  async getBalance(walletId: string): Promise<string> {
    const wallet = await this.getWalletById(walletId);

    try {
      const balance = await this.ethereumService.getBalance(wallet.address);
      return ethers.formatEther(balance); // Convert Wei to ETH
    } catch (error) {
      logger.error(`Failed to get balance: ${error.message}`);
      throw error;
    }
  }

  async setRecoveryEmail(walletId: string, recoveryEmail: string): Promise<Wallet> {
    const wallet = await this.getWalletById(walletId);
    wallet.recoveryEmail = recoveryEmail;
    return this.walletRepository.save(wallet);
  }
}
