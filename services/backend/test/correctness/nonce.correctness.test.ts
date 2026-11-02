import { ethers } from 'ethers';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { UserOpService } from '../../src/modules/account-abstraction/userop.service';
import { PaymasterService } from '../../src/modules/account-abstraction/paymaster.service';
import {
  toRpcUserOp,
  fromRpcUserOp,
  extractDestinations,
  encodeExecute,
  unpack128,
  DUMMY_SIGNATURE,
} from '../../src/modules/account-abstraction/userop-format';

jest.mock('../../src/modules/blockchain/ethereum.service', () => ({ EthereumService: jest.fn() }));

/**
 * CORRECTNESS: UserOp construction for EntryPoint v0.7, offline.
 * On-chain proof against the real EntryPoint lives in
 * services/contracts/test/SimpleAccount.test.ts and
 * test/integration/userop-hash.integration.test.ts.
 */
describe('UserOp construction (EntryPoint v0.7)', () => {
  const sender = ethers.Wallet.createRandom().address;
  const target = ethers.Wallet.createRandom().address;
  const sanctioned = ethers.Wallet.createRandom().address;
  const paymasterAddr = ethers.Wallet.createRandom().address;

  let svc: UserOpService;
  let sponsorUserOp: jest.Mock;
  let screenAddress: jest.Mock;

  beforeEach(() => {
    sponsorUserOp = jest.fn().mockImplementation(async (op) =>
      PaymasterService.mergeSponsorship(op, {
        paymaster: paymasterAddr,
        paymasterVerificationGasLimit: '0x249f0',
        paymasterPostOpGasLimit: '0xea60',
        paymasterData: '0x' + 'ab'.repeat(77),
      }),
    );
    screenAddress = jest.fn().mockImplementation(async (addr: string) =>
      addr.toLowerCase() === sanctioned.toLowerCase()
        ? { blocked: true, reason: 'Address matches sanctions list entry' }
        : { blocked: false },
    );
    svc = new UserOpService(
      { create: (x: any) => x, save: jest.fn() } as any,
      {
        getProvider: jest.fn(),
        estimateGas: jest.fn().mockResolvedValue(21000n),
        getGasPrice: jest.fn().mockResolvedValue(1_000_000_000n),
      } as any,
      { sponsorUserOp } as any,
      { screenAddress } as any,
    );
    jest.spyOn(svc as any, 'getNonce').mockResolvedValue(7n);
  });

  it('uses the EntryPoint nonce', async () => {
    const { userOp } = await svc.buildUserOp(sender, target, '0x');
    expect(userOp.nonce).toBe('7');
  });

  it('wraps the call in SimpleAccount.execute(target, value, data)', async () => {
    const { userOp } = await svc.buildUserOp(sender, target, '0x1234', undefined, { value: 5n });
    expect(userOp.callData).toBe(encodeExecute(target, 5n, '0x1234'));
  });

  it('packs accountGasLimits and gasFees as bytes32', async () => {
    const { userOp } = await svc.buildUserOp(sender, target, '0x');
    expect(userOp.accountGasLimits).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(userOp.gasFees).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('attaches sponsorship BEFORE hashing, so the returned hash covers paymasterAndData', async () => {
    const { userOp, userOpHash } = await svc.buildUserOp(sender, target, '0x');
    expect(ethers.dataSlice(userOp.paymasterAndData, 0, 20).toLowerCase()).toBe(paymasterAddr.toLowerCase());
    expect((svc as any).calculateUserOpHash(userOp)).toBe(userOpHash);

    const unsponsored = { ...userOp, paymasterAndData: '0x' };
    expect((svc as any).calculateUserOpHash(unsponsored)).not.toBe(userOpHash);
  });

  it('can build without sponsorship', async () => {
    const { userOp } = await svc.buildUserOp(sender, target, '0x', undefined, { sponsor: false });
    expect(userOp.paymasterAndData).toBe('0x');
    expect(sponsorUserOp).not.toHaveBeenCalled();
  });

  it('binds the nonce into the userOpHash', async () => {
    const { userOp, userOpHash } = await svc.buildUserOp(sender, target, '0x');
    userOp.nonce = '8';
    expect((svc as any).calculateUserOpHash(userOp)).not.toEqual(userOpHash);
  });

  it('signs with EIP-191 so the signature recovers to the owner over the returned hash', async () => {
    const owner = ethers.Wallet.createRandom();
    const { userOp, userOpHash } = await svc.buildUserOp(sender, target, '0x');
    const signature = await svc.signUserOp(userOp, owner.privateKey);
    expect(ethers.verifyMessage(ethers.getBytes(userOpHash), signature)).toBe(owner.address);
  });

  describe('sanctions screening on the gasless path', () => {
    it('blocks a direct call to a sanctioned address at build time', async () => {
      await expect(svc.buildUserOp(sender, sanctioned, '0x')).rejects.toBeInstanceOf(ForbiddenException);
      expect(sponsorUserOp).not.toHaveBeenCalled();
    });

    it('blocks an ERC-20 transfer whose recipient is sanctioned', async () => {
      const token = ethers.Wallet.createRandom().address;
      const transfer = new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [
        sanctioned,
        1000n,
      ]);
      await expect(svc.buildUserOp(sender, token, transfer)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('re-screens at send time (callData swapped after build)', async () => {
      const { userOp } = await svc.buildUserOp(sender, target, '0x');
      userOp.callData = encodeExecute(sanctioned, 1n, '0x');
      userOp.signature = '0x' + '11'.repeat(65);
      await expect(svc.sendUserOp(userOp, 'user-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects callData it cannot interpret instead of passing it unscreened', async () => {
      const { userOp } = await svc.buildUserOp(sender, target, '0x');
      userOp.callData = '0xdeadbeef';
      userOp.signature = '0x' + '11'.repeat(65);
      await expect(svc.sendUserOp(userOp, 'user-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('fails closed when the list is unavailable', async () => {
      screenAddress.mockResolvedValue({ blocked: true, reason: 'Sanctions list has never synced' });
      await expect(svc.buildUserOp(sender, target, '0x')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('refuses to send an unsigned op', async () => {
    const { userOp } = await svc.buildUserOp(sender, target, '0x');
    await expect(svc.sendUserOp(userOp, 'user-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('v0.7 bundler RPC format', () => {
  const factory = ethers.Wallet.createRandom().address;
  const pm = ethers.Wallet.createRandom().address;

  it('round-trips packed <-> RPC losslessly, including factory and paymaster fields', () => {
    const rpc = {
      sender: ethers.Wallet.createRandom().address,
      nonce: '0x3',
      factory,
      factoryData: '0xabcdef',
      callData: encodeExecute(ethers.Wallet.createRandom().address, 1n, '0x'),
      callGasLimit: '0x30d40',
      verificationGasLimit: '0x7a120',
      preVerificationGas: '0xea60',
      maxFeePerGas: '0x4a817c800',
      maxPriorityFeePerGas: '0x3b9aca00',
      paymaster: pm,
      paymasterVerificationGasLimit: '0x249f0',
      paymasterPostOpGasLimit: '0xea60',
      paymasterData: '0x1234',
      signature: '0x' + '22'.repeat(65),
    };
    const packed = fromRpcUserOp(rpc);
    expect(ethers.dataSlice(packed.initCode, 0, 20).toLowerCase()).toBe(factory.toLowerCase());
    expect(unpack128(packed.accountGasLimits)).toEqual([0x7a120n, 0x30d40n]);
    expect(unpack128(packed.gasFees)).toEqual([0x3b9aca00n, 0x4a817c800n]);
    expect(toRpcUserOp(packed)).toEqual(rpc);
  });

  it('omits factory/paymaster fields when unused', () => {
    const rpc = toRpcUserOp({
      sender: ethers.Wallet.createRandom().address,
      nonce: '0',
      initCode: '0x',
      callData: '0x',
      accountGasLimits: ethers.zeroPadValue('0x01', 32),
      preVerificationGas: '1',
      gasFees: ethers.zeroPadValue('0x01', 32),
      paymasterAndData: '0x',
      signature: '0x',
    });
    expect(rpc.factory).toBeUndefined();
    expect(rpc.paymaster).toBeUndefined();
  });

  it('uses a well-formed 65-byte placeholder signature for sponsorship simulation', () => {
    expect(ethers.dataLength(DUMMY_SIGNATURE)).toBe(65);
  });

  it('extracts every destination from executeBatch', () => {
    const a = ethers.Wallet.createRandom().address;
    const b = ethers.Wallet.createRandom().address;
    const data = new ethers.Interface(['function executeBatch(address[],uint256[],bytes[])']).encodeFunctionData(
      'executeBatch',
      [[a, b], [], ['0x', '0x']],
    );
    expect(extractDestinations(data)).toEqual([a, b]);
  });
});
