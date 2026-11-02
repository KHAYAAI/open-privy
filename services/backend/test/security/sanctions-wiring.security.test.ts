import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { ethers } from 'ethers';

// This test only exercises the EVM custodial-send path. SolanaService pulls in
// @solana/web3.js -> rpc-websockets -> an ESM-only uuid build that ts-jest's
// CJS resolution can't load; mock it out at the module level so this test (and
// any other that imports WalletService) doesn't have to load that chain at all.
// An explicit factory is required here — jest.mock() with no factory still
// *automocks* by requiring the real module to introspect its shape, which
// would load the exact ESM chain this is trying to avoid.
jest.mock('../../src/modules/blockchain/solana.service', () => ({
  SolanaService: jest.fn(),
}));

import { TransactionService } from '../../src/modules/transactions/transaction.service';

/**
 * Proves sanctions screening is actually wired into the custodial send path
 * — not just implemented in isolation. A blocked destination must be
 * rejected BEFORE the signer is ever asked to decrypt/sign anything.
 */
describe('TransactionService — sanctions screening wiring', () => {
  const userId = 'user-1';
  const walletId = 'wallet-1';
  const wallet = { id: walletId, userId, chain: 'ethereum', address: '0xaaa' };

  function makeService(blocked: boolean) {
    const txRepo: any = {
      create: jest.fn((d) => d),
      save: jest.fn(async (d) => d),
    };
    const ethereumService: any = {
      getProvider: jest.fn(() => ({})),
    };
    const walletService: any = {
      getWalletById: jest.fn(async () => wallet),
      getEvmSigner: jest.fn(),
    };
    const sanctionsService: any = {
      screenAddress: jest.fn(async () => ({
        blocked,
        reason: blocked ? 'Address matches sanctions list entry (TEST)' : undefined,
      })),
    };

    const service = new TransactionService(txRepo, ethereumService, walletService, sanctionsService);
    return { service, walletService, sanctionsService, txRepo };
  }

  it('rejects a send to a blocked address without ever requesting a signer', async () => {
    const { service, walletService, sanctionsService } = makeService(true);
    const target = ethers.Wallet.createRandom().address;

    await expect(service.sendTransaction(userId, walletId, target, '0.01')).rejects.toThrow(
      ForbiddenException,
    );

    expect(sanctionsService.screenAddress).toHaveBeenCalledWith(target, 'ethereum');
    expect(walletService.getEvmSigner).not.toHaveBeenCalled();
  });

  it('proceeds to request a signer when the address is clean', async () => {
    const { service, walletService } = makeService(false);
    const target = ethers.Wallet.createRandom().address;
    walletService.getEvmSigner.mockResolvedValue({
      sendTransaction: jest.fn(async () => ({ hash: '0xdeadbeef' })),
    });

    const result = await service.sendTransaction(userId, walletId, target, '0.01');

    expect(walletService.getEvmSigner).toHaveBeenCalled();
    expect(result.txHash).toBe('0xdeadbeef');
  });

  it('rejects an invalid destination before screening is even relevant', async () => {
    const { service, sanctionsService } = makeService(false);
    await expect(
      service.sendTransaction(userId, walletId, 'not-an-address', '0.01'),
    ).rejects.toThrow(BadRequestException);
    expect(sanctionsService.screenAddress).not.toHaveBeenCalled();
  });
});
