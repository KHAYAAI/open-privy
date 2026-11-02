import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ethers } from 'ethers';

jest.mock('../../src/modules/blockchain/solana.service', () => ({
  SolanaService: jest.fn(),
}));

import { WalletService } from '../../src/modules/wallet/wallet.service';
import { HsmSigningKey } from '../../src/common/signing/hsm-signing-key';

/**
 * Proves WalletService's HSM branch is wired correctly — real cryptographic
 * behaviour of HsmSigningKey itself is covered against a real PKCS#11 token
 * in hsm-signing-key.security.test.ts; this is a fast, hermetic test of the
 * wiring (which branch runs, what gets persisted, what gets refused).
 */
describe('WalletService — HSM signing mode wiring', () => {
  const userId = 'user-1';

  function makeService(pkcs11Configured: boolean) {
    const walletRepo: any = {
      findOne: jest.fn(async () => null),
      create: jest.fn((d: any) => d),
      save: jest.fn(async (d: any) => d),
    };
    const ethereumService: any = {};
    const solanaService: any = {};
    const polygonService: any = {};
    const encryptionService: any = {};
    const pkcs11Service: any = {
      isConfigured: jest.fn(() => pkcs11Configured),
      getSession: jest.fn(() => ({ fakeSession: true })),
    };

    const service = new WalletService(
      walletRepo,
      ethereumService,
      solanaService,
      polygonService,
      encryptionService,
      pkcs11Service,
    );
    return { service, walletRepo, pkcs11Service };
  }

  afterEach(() => jest.restoreAllMocks());

  it('refuses HSM mode when no PKCS#11 module is configured', async () => {
    const { service } = makeService(false);
    await expect(service.createWallet(userId, 'ethereum', 'hsm')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuses HSM mode for a non-EVM chain', async () => {
    const { service } = makeService(true);
    await expect(service.createWallet(userId, 'solana', 'hsm')).rejects.toThrow(
      /does not support chain/,
    );
  });

  it('creates an HSM wallet with no encryptedPrivateKey and a hsmKeyLabel set', async () => {
    const { service, walletRepo, pkcs11Service } = makeService(true);

    // A real uncompressed public key from a real (throwaway) keypair — a
    // hand-rolled hex string isn't a valid point on the curve and
    // ethers.computeAddress correctly rejects it.
    const fakePublicKey = new ethers.SigningKey(ethers.Wallet.createRandom().privateKey).publicKey;
    jest.spyOn(HsmSigningKey, 'generate').mockReturnValue({
      publicKey: fakePublicKey,
      sign: jest.fn(),
    } as any);

    const wallet = await service.createWallet(userId, 'ethereum', 'hsm');

    expect(pkcs11Service.getSession).toHaveBeenCalled();
    expect(wallet.signingMode).toBe('hsm');
    expect(wallet.encryptedPrivateKey).toBeNull();
    expect(wallet.hsmKeyLabel).toMatch(new RegExp(`^openprivy-${userId}-`));
    expect(wallet.address).toBe(ethers.computeAddress(fakePublicKey));
    expect(walletRepo.save).toHaveBeenCalled();
  });

  it('getEvmSigner returns a BaseWallet backed by HsmSigningKey.load for an HSM wallet', async () => {
    const { service, walletRepo } = makeService(true);
    const fakePublicKey = new ethers.SigningKey(ethers.Wallet.createRandom().privateKey).publicKey;
    const fakeAddress = ethers.computeAddress(fakePublicKey);

    walletRepo.findOne.mockResolvedValue({
      id: 'wallet-1',
      userId,
      chain: 'ethereum',
      signingMode: 'hsm',
      hsmKeyLabel: 'openprivy-user-1-abc',
      address: fakeAddress,
    });

    jest.spyOn(HsmSigningKey, 'load').mockReturnValue({
      publicKey: fakePublicKey,
      sign: jest.fn(),
    } as any);

    const signer = await service.getEvmSigner('wallet-1', userId, {} as any);
    expect(await signer.getAddress()).toBe(fakeAddress);
  });

  it('getDecryptedPrivateKey refuses an HSM wallet — there is no plaintext key', async () => {
    const { service, walletRepo } = makeService(true);
    walletRepo.findOne.mockResolvedValue({
      id: 'wallet-1',
      userId,
      signingMode: 'hsm',
      encryptedPrivateKey: null,
    });

    await expect(service.getDecryptedPrivateKey('wallet-1', userId)).rejects.toThrow(
      /not extractable/,
    );
  });

  it('still refuses a wallet that belongs to a different user, HSM or not', async () => {
    const { service, walletRepo } = makeService(true);
    walletRepo.findOne.mockResolvedValue({
      id: 'wallet-1',
      userId: 'someone-else',
      signingMode: 'hsm',
    });

    await expect(service.getEvmSigner('wallet-1', userId, {} as any)).rejects.toThrow(
      ForbiddenException,
    );
  });
});
