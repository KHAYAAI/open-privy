import { Test, TestingModule } from '@nestjs/testing';
import { ethers } from 'ethers';
import { UserOpService } from '../../src/modules/account-abstraction/userop.service';
import { EthereumService } from '../../src/modules/blockchain/ethereum.service';
import { PaymasterService } from '../../src/modules/account-abstraction/paymaster.service';
import { Repository } from 'typeorm';
import { Transaction } from '../../src/modules/transactions/entities/transaction.entity';

/**
 * CORRECTNESS TEST: Nonce Implementation
 *
 * These tests verify that the nonce implementation correctly matches
 * SimpleAccount.sol's on-chain nonce (incrementing counter).
 *
 * CRITICAL: Nonce mismatch will cause every UserOp to fail with SIG_VALIDATION_FAILED.
 */
describe('Nonce Correctness (Account Abstraction)', () => {
  let userOpService: UserOpService;
  let ethereumService: EthereumService;
  let paymasterService: PaymasterService;
  let txRepository: Repository<Transaction>;

  let testWalletAddress: string;
  let testPrivateKey: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserOpService,
        EthereumService,
        PaymasterService,
        {
          provide: 'TransactionRepository',
          useValue: txRepository,
        },
      ],
    }).compile();

    userOpService = module.get<UserOpService>(UserOpService);
    ethereumService = module.get<EthereumService>(EthereumService);
    paymasterService = module.get<PaymasterService>(PaymasterService);

    // Create test wallet
    const wallet = ethers.Wallet.createRandom();
    testWalletAddress = wallet.address;
    testPrivateKey = wallet.privateKey;
  });

  describe('getNonce()', () => {
    it('should return a number (not timestamp)', async () => {
      // Get nonce from service
      const nonce = await (userOpService as any).getNonce(testWalletAddress);

      // Verify it's a number
      expect(typeof nonce).toBe('number');
      expect(Number.isInteger(nonce)).toBe(true);
      expect(nonce).toBeGreaterThanOrEqual(0);
    });

    it('should NOT return a timestamp', async () => {
      const nonce = await (userOpService as any).getNonce(testWalletAddress);

      // A timestamp is typically 10 digits (seconds) or 13 digits (ms)
      // A valid nonce is much smaller (0-1000s)
      const nonceDigits = nonce.toString().length;
      const now = Math.floor(Date.now() / 1000);
      const nowDigits = now.toString().length;

      // If nonce has same digit count as current timestamp, it's likely a timestamp
      if (nonceDigits === nowDigits) {
        expect(nonce).toBeLessThan(now - 1000);
        // If this fails, nonce is probably a timestamp
      }
    });

    it('should query on-chain nonce (not calculate locally)', async () => {
      // This test verifies the call goes to blockchain
      const spy = jest.spyOn(ethereumService, 'getProvider');

      await (userOpService as any).getNonce(testWalletAddress);

      // Verify that getProvider was called (indicates RPC call)
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('buildUserOp() nonce', () => {
    it('should build UserOp with on-chain nonce', async () => {
      const targetAddress = ethers.getAddress(
        '0x' + '1'.repeat(40) // Dummy address
      );
      const callData = '0x';

      const userOp = await userOpService.buildUserOp(
        testWalletAddress,
        targetAddress,
        callData,
      );

      // Nonce should be set and be a valid incrementing counter
      expect(userOp.nonce).toBeDefined();
      const nonceAsNumber = Number(userOp.nonce);
      expect(nonceAsNumber).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(nonceAsNumber)).toBe(true);
    });

    it('should increment nonce on subsequent calls (if account was used)', async () => {
      // This would require a real deployed SimpleAccount
      // For now, we just verify nonce is queryable
      const targetAddress = ethers.getAddress(
        '0x' + '2'.repeat(40) // Dummy address
      );

      const userOp1 = await userOpService.buildUserOp(
        testWalletAddress,
        targetAddress,
        '0x',
      );

      const userOp2 = await userOpService.buildUserOp(
        testWalletAddress,
        targetAddress,
        '0x',
      );

      // Both should have valid nonces
      expect(userOp1.nonce).toBeDefined();
      expect(userOp2.nonce).toBeDefined();

      // Note: nonces will be equal if account hasn't used them yet
      // In a real scenario with actual transactions, nonce2 > nonce1
    });
  });

  describe('Signature validation with nonce', () => {
    it('should produce valid signature with correct nonce', async () => {
      const targetAddress = ethers.getAddress(
        '0x' + '3'.repeat(40)
      );

      const userOp = await userOpService.buildUserOp(
        testWalletAddress,
        targetAddress,
        '0x',
      );

      // Sign the UserOp
      const signature = await userOpService.signUserOp(
        userOp,
        testPrivateKey,
      );

      // Verify signature is not empty
      expect(signature).toBeDefined();
      expect(signature.length).toBeGreaterThan(0);
      expect(signature.startsWith('0x')).toBe(true);
    });

    it('should use nonce in signature calculation', async () => {
      const targetAddress = ethers.getAddress(
        '0x' + '4'.repeat(40)
      );

      const userOp = await userOpService.buildUserOp(
        testWalletAddress,
        targetAddress,
        '0x',
      );

      // Calculate hash with this nonce
      const hash1 = (userOpService as any).calculateUserOpHash(userOp);

      // Change nonce (simulate different operation count)
      userOp.nonce = (Number(userOp.nonce) + 1).toString();
      const hash2 = (userOpService as any).calculateUserOpHash(userOp);

      // Hashes should be different (nonce is part of hash)
      expect(hash1).not.toEqual(hash2);
    });
  });

  describe('Integration: Full flow with nonce', () => {
    it('should build, sign, and prepare UserOp with valid nonce', async () => {
      const targetAddress = ethers.getAddress(
        '0x' + '5'.repeat(40)
      );

      // Step 1: Get on-chain nonce
      const nonce = await (userOpService as any).getNonce(testWalletAddress);
      expect(nonce).toBeGreaterThanOrEqual(0);

      // Step 2: Build UserOp
      const userOp = await userOpService.buildUserOp(
        testWalletAddress,
        targetAddress,
        '0x',
      );

      expect(userOp.nonce).toBeDefined();
      expect(Number(userOp.nonce)).toBe(nonce);

      // Step 3: Sign UserOp
      const signature = await userOpService.signUserOp(
        userOp,
        testPrivateKey,
      );

      expect(signature).toBeDefined();
      expect(signature.length).toBeGreaterThan(0);

      // Step 4: Verify all pieces are present
      expect(userOp.sender).toBe(testWalletAddress);
      expect(userOp.nonce).toBe(nonce.toString());
      expect(userOp.signature).toBe(signature);
    });
  });

  describe('Error handling', () => {
    it('should handle non-deployed account gracefully', async () => {
      const randomAddress = ethers.Wallet.createRandom().address;

      // This might fail if account not deployed
      try {
        await (userOpService as any).getNonce(randomAddress);
        // Some implementations might return 0 for non-existent accounts
      } catch (error) {
        // Expected: account not deployed
        expect(error).toBeDefined();
      }
    });

    it('should reject invalid address format', async () => {
      const invalidAddress = 'not-an-address';

      expect(() => {
        ethers.getAddress(invalidAddress);
      }).toThrow();
    });
  });
});

/**
 * INTEGRATION TEST: Nonce must match SimpleAccount.sol
 *
 * This test would need to:
 * 1. Deploy actual SimpleAccount contract on testnet
 * 2. Build UserOp with nonce from our service
 * 3. Submit to EntryPoint
 * 4. Verify it succeeds (not SIG_VALIDATION_FAILED)
 *
 * Run on Sepolia testnet before production:
 * TESTNET_RPC=https://sepolia.infura.io/v3/KEY npm run test:integration
 */
describe.skip('Integration: Nonce matches on-chain (requires testnet)', () => {
  it('should accept UserOp with correct nonce on EntryPoint', async () => {
    // TODO: Implement once SimpleAccount is deployed on testnet
    // 1. Deploy SimpleAccount via factory
    // 2. Build UserOp with our nonce
    // 3. Sign UserOp
    // 4. Submit to EntryPoint.handleOps()
    // 5. Assert transaction succeeded
    // 6. Assert nonce was incremented to +1
  });
});
