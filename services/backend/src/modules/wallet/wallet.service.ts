import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ethers } from 'ethers';
import { Wallet } from './entities/wallet.entity';
import { EthereumService } from '../blockchain/ethereum.service';
import { SolanaService } from '../blockchain/solana.service';
import { PolygonService } from '../blockchain/polygon.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { Pkcs11Service } from '../../common/signing/pkcs11.service';
import { HsmSigningKey } from '../../common/signing/hsm-signing-key';
import { logger } from '../../common/logger';
import * as crypto from 'crypto';

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(Wallet)
    private walletRepository: Repository<Wallet>,
    private ethereumService: EthereumService,
    private solanaService: SolanaService,
    private polygonService: PolygonService,
    private encryptionService: EncryptionService,
    private pkcs11Service: Pkcs11Service,
  ) {}

  async createWallet(
    userId: string,
    chain: string,
    signingMode: 'software' | 'hsm' = 'software',
  ): Promise<Wallet> {
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

      if (signingMode === 'hsm') {
        return this.createHsmWallet(userId, chain);
      }

      let address: string;
      let publicKey: string;
      let privateKey: string;

      // Create wallet based on chain
      switch (chain.toLowerCase()) {
        case 'ethereum':
        case 'polygon':
          const ethersWallet = ethers.Wallet.createRandom();
          address = ethersWallet.address;
          publicKey = ethersWallet.publicKey;
          privateKey = ethersWallet.privateKey;
          break;

        case 'solana':
          const solanaWallet = await this.solanaService.createWallet();
          // Solana's public key doubles as the account address; the secret key
          // is the private key material to be encrypted.
          address = solanaWallet.publicKey;
          publicKey = solanaWallet.publicKey;
          privateKey = solanaWallet.secretKey;
          break;

        default:
          throw new BadRequestException(`Unsupported chain: ${chain}`);
      }

      // Encrypt private key with per-user key
      // Uses AES-256-GCM with per-user key derived from master key
      const encryptedPrivateKey = await this.encryptionService.encrypt(
        privateKey,
        userId,
      );

      // Create wallet record
      const wallet = this.walletRepository.create({
        userId,
        address,
        chain,
        publicKey,
        encryptedPrivateKey,
        encryptionKeyId: this.encryptionService.currentKeyId,
        signingMode: 'software',
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

  /**
   * Create a wallet whose key is generated non-extractable on a PKCS#11
   * token (CloudHSM/Luna/YubiHSM/SoftHSM2), instead of encrypted in the
   * database. There is no plaintext key at any point after generation —
   * encryptedPrivateKey stays null for the life of this wallet.
   *
   * EVM only: the single-key HSM path here signs secp256k1 digests, which
   * covers Ethereum/Polygon; Solana's Ed25519 keys are a different curve and
   * aren't wired to this path.
   */
  private async createHsmWallet(userId: string, chain: string): Promise<Wallet> {
    const normalizedChain = chain.toLowerCase();
    if (normalizedChain !== 'ethereum' && normalizedChain !== 'polygon') {
      throw new BadRequestException(
        `HSM signing mode does not support chain: ${chain}`,
      );
    }

    if (!this.pkcs11Service.isConfigured()) {
      throw new BadRequestException(
        'HSM signing mode requested but no PKCS#11 module is configured (PKCS11_MODULE_PATH)',
      );
    }

    const session = this.pkcs11Service.getSession();
    const hsmKeyLabel = `openprivy-${userId}-${crypto.randomUUID()}`;
    const signingKey = HsmSigningKey.generate(session, hsmKeyLabel);
    const address = ethers.computeAddress(signingKey.publicKey);

    const wallet = this.walletRepository.create({
      userId,
      address,
      chain,
      publicKey: signingKey.publicKey,
      encryptedPrivateKey: null,
      encryptionKeyId: null,
      signingMode: 'hsm',
      hsmKeyLabel,
      recoveryEmail: null,
      isActive: true,
    });

    await this.walletRepository.save(wallet);
    logger.info(`HSM wallet created for user ${userId} on chain ${chain} (label=${hsmKeyLabel})`);
    return wallet;
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

  async getBalance(walletId: string, userId: string): Promise<string> {
    const wallet = await this.getOwnedWallet(walletId, userId);

    try {
      let balance: string;

      switch (wallet.chain.toLowerCase()) {
        case 'ethereum':
          const ethBalance = await this.ethereumService.getBalance(wallet.address);
          balance = ethers.formatEther(ethBalance);
          break;

        case 'polygon':
          const polyBalance = await this.polygonService.getBalance(wallet.address);
          balance = ethers.formatEther(polyBalance);
          break;

        case 'solana':
          balance = (await this.solanaService.getBalance(wallet.address)).toString();
          break;

        default:
          throw new BadRequestException(`Unsupported chain: ${wallet.chain}`);
      }

      return balance;
    } catch (error) {
      logger.error(`Failed to get balance: ${error.message}`);
      throw error;
    }
  }

  async setRecoveryEmail(walletId: string, userId: string, recoveryEmail: string): Promise<Wallet> {
    const wallet = await this.getOwnedWallet(walletId, userId);
    wallet.recoveryEmail = recoveryEmail;
    return this.walletRepository.save(wallet);
  }

  /**
   * Decrypt a wallet's private key for server-side (custodial) signing.
   *
   * SECURITY: This is the ONLY place a stored key is turned back into
   * plaintext. Callers MUST pass the authenticated userId; the key is only
   * released if the wallet belongs to that user, and the per-user encryption
   * key is derived from that same userId (so a mismatched user cannot decrypt).
   *
   * The plaintext key must never be logged, persisted, or returned to a client.
   */
  /** Loads a wallet only if it belongs to userId; otherwise 403. */
  async getOwnedWallet(walletId: string, userId: string): Promise<Wallet> {
    if (!userId) throw new ForbiddenException('Wallet does not belong to this user');
    const wallet = await this.getWalletById(walletId);
    if (wallet.userId !== userId) {
      throw new ForbiddenException('Wallet does not belong to this user');
    }
    return wallet;
  }

  async getDecryptedPrivateKey(walletId: string, userId: string): Promise<string> {
    const wallet = await this.getWalletById(walletId);

    if (wallet.userId !== userId) {
      throw new ForbiddenException('Wallet does not belong to this user');
    }

    if (wallet.signingMode === 'hsm') {
      throw new BadRequestException(
        'Wallet is HSM-signed; its key is not extractable and has no plaintext form',
      );
    }

    if (!wallet.encryptedPrivateKey) {
      throw new BadRequestException('Wallet has no key material to decrypt');
    }

    return this.encryptionService.decrypt(wallet.encryptedPrivateKey, userId);
  }

  /**
   * Build a signer connected to the given provider for a custodial EVM
   * wallet. Used by the transaction service to sign and broadcast on the
   * user's behalf. Transparently branches on the wallet's signing mode:
   * software wallets decrypt a key into an ethers.Wallet as before;
   * HSM wallets never produce a plaintext key at all — signing happens on
   * the token via HsmSigningKey, wrapped in ethers' own BaseWallet so the
   * caller (sendTransaction) sees an identical interface either way.
   */
  async getEvmSigner(
    walletId: string,
    userId: string,
    provider: ethers.Provider,
  ): Promise<ethers.Signer> {
    const wallet = await this.getWalletById(walletId);

    if (wallet.userId !== userId) {
      throw new ForbiddenException('Wallet does not belong to this user');
    }

    const chain = wallet.chain.toLowerCase();
    if (chain !== 'ethereum' && chain !== 'polygon') {
      throw new BadRequestException(
        `getEvmSigner does not support chain: ${wallet.chain}`,
      );
    }

    if (wallet.signingMode === 'hsm') {
      if (!wallet.hsmKeyLabel) {
        throw new BadRequestException('HSM wallet is missing its key label');
      }
      const session = this.pkcs11Service.getSession();
      const signingKey = HsmSigningKey.load(session, wallet.hsmKeyLabel);
      // BaseWallet's constructor is nominally typed to the concrete
      // ethers.SigningKey class, but at runtime it only ever calls
      // `.sign(digest)` and reads `.publicKey` — exactly what HsmSigningKey
      // implements. This cast reflects that real (duck-typed) contract.
      return new ethers.BaseWallet(signingKey as unknown as ethers.SigningKey, provider);
    }

    const privateKey = await this.getDecryptedPrivateKey(walletId, userId);
    return new ethers.Wallet(privateKey, provider);
  }
}
