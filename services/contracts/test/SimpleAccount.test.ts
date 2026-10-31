import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * End-to-end against the REAL EntryPoint v0.7 (compiled from
 * @account-abstraction/contracts), driven exactly as a bundler would:
 * build a PackedUserOperation, sign the EntryPoint's userOpHash, call handleOps.
 */

const coder = ethers.AbiCoder.defaultAbiCoder();
const pack128 = (hi: bigint, lo: bigint) => ethers.solidityPacked(['uint128', 'uint128'], [hi, lo]);

// Same algorithm as services/backend UserOpService.calculateUserOpHash.
function backendUserOpHash(op: any, entryPoint: string, chainId: bigint): string {
  const inner = ethers.keccak256(
    coder.encode(
      ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
      [
        op.sender,
        op.nonce,
        ethers.keccak256(op.initCode),
        ethers.keccak256(op.callData),
        op.accountGasLimits,
        op.preVerificationGas,
        op.gasFees,
        ethers.keccak256(op.paymasterAndData),
      ],
    ),
  );
  return ethers.keccak256(coder.encode(['bytes32', 'address', 'uint256'], [inner, entryPoint, chainId]));
}

describe('SimpleAccount on EntryPoint v0.7', () => {
  let entryPoint: any;
  let factory: any;
  let paymaster: any;
  let owner: HardhatEthersSigner;
  let bundler: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let pmSigner: HardhatEthersSigner;
  let chainId: bigint;
  let salt = 0n;

  beforeEach(async () => {
    [owner, bundler, recipient, stranger, pmSigner] = await ethers.getSigners();
    entryPoint = await ethers.deployContract('EntryPoint');
    factory = await ethers.deployContract('SimpleAccountFactory', [await entryPoint.getAddress()]);
    paymaster = await ethers.deployContract('OpenPrivyPaymaster', [await entryPoint.getAddress(), pmSigner.address]);
    chainId = (await ethers.provider.getNetwork()).chainId;
    salt++;
  });

  async function buildOp(sender: string, callData: string, opts: { initCode?: string; nonce?: bigint; paymasterAndData?: string } = {}) {
    return {
      sender,
      nonce: opts.nonce ?? (await entryPoint.getNonce(sender, 0)),
      initCode: opts.initCode ?? '0x',
      callData,
      accountGasLimits: pack128(600_000n, 200_000n), // verificationGasLimit | callGasLimit
      preVerificationGas: 60_000n,
      gasFees: pack128(1_000_000_000n, 20_000_000_000n), // maxPriority | maxFee
      paymasterAndData: opts.paymasterAndData ?? '0x',
      signature: '0x',
    };
  }

  async function sign(op: any, signer: HardhatEthersSigner) {
    const hash = await entryPoint.getUserOpHash(op);
    op.signature = await signer.signMessage(ethers.getBytes(hash));
    return op;
  }

  async function counterfactual(ownerAddr = owner.address) {
    const sender = await factory.getAccountAddress(ownerAddr, salt);
    const initCode = ethers.concat([
      await factory.getAddress(),
      factory.interface.encodeFunctionData('createAccount', [ownerAddr, salt]),
    ]);
    return { sender, initCode };
  }

  const transferCall = (to: string, value: bigint) =>
    new ethers.Interface(['function execute(address,uint256,bytes)']).encodeFunctionData('execute', [to, value, '0x']);

  it('backend userOpHash algorithm equals EntryPoint.getUserOpHash', async () => {
    const { sender, initCode } = await counterfactual();
    const op = await buildOp(sender, transferCall(recipient.address, 1n), { initCode });
    const onchain = await entryPoint.getUserOpHash(op);
    expect(backendUserOpHash(op, await entryPoint.getAddress(), chainId)).to.equal(onchain);
  });

  it('deploys the account on its first UserOp and executes a transfer', async () => {
    const { sender, initCode } = await counterfactual();
    expect(await ethers.provider.getCode(sender)).to.equal('0x');
    await owner.sendTransaction({ to: sender, value: ethers.parseEther('1') });

    const before = await ethers.provider.getBalance(recipient.address);
    const op = await sign(await buildOp(sender, transferCall(recipient.address, ethers.parseEther('0.1')), { initCode }), owner);
    await expect(entryPoint.connect(bundler).handleOps([op], bundler.address))
      .to.emit(entryPoint, 'UserOperationEvent');

    expect(await ethers.provider.getCode(sender)).to.not.equal('0x');
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(before + ethers.parseEther('0.1'));
    const account = await ethers.getContractAt('SimpleAccount', sender);
    expect(await account.owner()).to.equal(owner.address);
    // Regression: the old contract stored entryPoint in implementation storage,
    // so every proxy saw address(0) and rejected the EntryPoint.
    expect(await account.entryPoint()).to.equal(await entryPoint.getAddress());
  });

  it('uses EntryPoint-managed nonces: sequential ops succeed, replay is rejected', async () => {
    const { sender, initCode } = await counterfactual();
    await owner.sendTransaction({ to: sender, value: ethers.parseEther('1') });

    const op0 = await sign(await buildOp(sender, transferCall(recipient.address, 1n), { initCode }), owner);
    await entryPoint.connect(bundler).handleOps([op0], bundler.address);
    expect(await entryPoint.getNonce(sender, 0)).to.equal(1n);

    const op1 = await sign(await buildOp(sender, transferCall(recipient.address, 2n)), owner);
    expect(op1.nonce).to.equal(1n);
    await entryPoint.connect(bundler).handleOps([op1], bundler.address);
    expect(await entryPoint.getNonce(sender, 0)).to.equal(2n);

    await expect(entryPoint.connect(bundler).handleOps([op1], bundler.address))
      .to.be.revertedWithCustomError(entryPoint, 'FailedOp')
      .withArgs(0, 'AA25 invalid account nonce');
  });

  it('rejects a UserOp signed by anyone other than the owner', async () => {
    const { sender, initCode } = await counterfactual();
    await owner.sendTransaction({ to: sender, value: ethers.parseEther('1') });
    const op = await sign(await buildOp(sender, transferCall(stranger.address, ethers.parseEther('0.5')), { initCode }), stranger);
    await expect(entryPoint.connect(bundler).handleOps([op], bundler.address))
      .to.be.revertedWithCustomError(entryPoint, 'FailedOp')
      .withArgs(0, 'AA24 signature error');
  });

  it('rejects a malformed signature without reverting inside the account', async () => {
    const { sender, initCode } = await counterfactual();
    await owner.sendTransaction({ to: sender, value: ethers.parseEther('1') });
    const op = await buildOp(sender, transferCall(stranger.address, 1n), { initCode });
    op.signature = '0x1234';
    await expect(entryPoint.connect(bundler).handleOps([op], bundler.address))
      .to.be.revertedWithCustomError(entryPoint, 'FailedOp')
      .withArgs(0, 'AA24 signature error');
  });

  it('only the EntryPoint or owner can execute; only the owner can upgrade', async () => {
    await factory.createAccount(owner.address, salt);
    const sender = await factory.getAccountAddress(owner.address, salt);
    const account = await ethers.getContractAt('SimpleAccount', sender);
    await owner.sendTransaction({ to: sender, value: ethers.parseEther('1') });

    await expect(account.connect(stranger).execute(stranger.address, 1n, '0x')).to.be.revertedWith(
      'account: not Owner or EntryPoint',
    );
    await expect(account.connect(owner).execute(recipient.address, 1n, '0x')).to.not.be.reverted;

    const newImpl = await ethers.deployContract('SimpleAccount', [await entryPoint.getAddress()]);
    await expect(account.connect(stranger).upgradeToAndCall(await newImpl.getAddress(), '0x')).to.be.revertedWith('only owner');
    await expect(account.connect(owner).upgradeToAndCall(await newImpl.getAddress(), '0x')).to.not.be.reverted;
    expect(await account.getImplementation()).to.equal(await newImpl.getAddress());
  });

  it('cannot be re-initialized (implementation or proxy)', async () => {
    await factory.createAccount(owner.address, salt);
    const account = await ethers.getContractAt('SimpleAccount', await factory.getAccountAddress(owner.address, salt));
    await expect(account.initialize(stranger.address)).to.be.revertedWithCustomError(account, 'InvalidInitialization');
    const impl = await ethers.getContractAt('SimpleAccount', await factory.accountImplementation());
    await expect(impl.initialize(stranger.address)).to.be.revertedWithCustomError(impl, 'InvalidInitialization');
  });

  it('owner rotation via UserOp: the old key stops working', async () => {
    const { sender, initCode } = await counterfactual();
    await owner.sendTransaction({ to: sender, value: ethers.parseEther('1') });
    const rotate = new ethers.Interface(['function execute(address,uint256,bytes)', 'function updateOwner(address)']);
    const callData = rotate.encodeFunctionData('execute', [
      sender,
      0n,
      rotate.encodeFunctionData('updateOwner', [stranger.address]),
    ]);
    await entryPoint.connect(bundler).handleOps([await sign(await buildOp(sender, callData, { initCode }), owner)], bundler.address);
    const account = await ethers.getContractAt('SimpleAccount', sender);
    expect(await account.owner()).to.equal(stranger.address);

    const stale = await sign(await buildOp(sender, transferCall(owner.address, 1n)), owner);
    await expect(entryPoint.connect(bundler).handleOps([stale], bundler.address))
      .to.be.revertedWithCustomError(entryPoint, 'FailedOp')
      .withArgs(0, 'AA24 signature error');
    const fresh = await sign(await buildOp(sender, transferCall(recipient.address, 1n)), stranger);
    await expect(entryPoint.connect(bundler).handleOps([fresh], bundler.address)).to.not.be.reverted;
  });

  describe('OpenPrivyPaymaster (gas sponsorship)', () => {
    const PM_VERIFICATION_GAS = 150_000n;
    const PM_POSTOP_GAS = 60_000n;

    async function paymasterAndData(op: any, signer: HardhatEthersSigner, validUntil = 0, validAfter = 0) {
      const prefix = ethers.concat([
        await paymaster.getAddress(),
        ethers.toBeHex(PM_VERIFICATION_GAS, 16),
        ethers.toBeHex(PM_POSTOP_GAS, 16),
        coder.encode(['uint48', 'uint48'], [validUntil, validAfter]),
      ]);
      // getHash reads the gas-limit slice from paymasterAndData, so hash with the
      // final layout (prefix + a placeholder signature of the right length).
      const draft = { ...op, paymasterAndData: ethers.concat([prefix, '0x' + '00'.repeat(65)]) };
      const hash = await paymaster.getHash(draft, validUntil, validAfter);
      const sig = await signer.signMessage(ethers.getBytes(hash));
      return ethers.concat([prefix, sig]);
    }

    beforeEach(async () => {
      await paymaster.deposit({ value: ethers.parseEther('2') });
    });

    it('sponsors an allow-listed account: user pays zero gas', async () => {
      const { sender, initCode } = await counterfactual();
      await paymaster.setSponsorshipStatus(sender, true);
      await owner.sendTransaction({ to: sender, value: ethers.parseEther('1') });
      const accountBefore = await ethers.provider.getBalance(sender);
      const pmDepositBefore = await entryPoint.balanceOf(await paymaster.getAddress());

      const op = await buildOp(sender, transferCall(recipient.address, ethers.parseEther('0.25')), { initCode });
      op.paymasterAndData = await paymasterAndData(op, pmSigner);
      await sign(op, owner);
      await entryPoint.connect(bundler).handleOps([op], bundler.address);

      expect(await ethers.provider.getBalance(sender)).to.equal(accountBefore - ethers.parseEther('0.25'));
      const spent = pmDepositBefore - (await entryPoint.balanceOf(await paymaster.getAddress()));
      expect(spent).to.be.greaterThan(0n);
      expect(await paymaster.gasSponsored(sender)).to.be.greaterThan(0n);
    });

    it('refuses accounts that are not allow-listed', async () => {
      const { sender, initCode } = await counterfactual();
      const op = await buildOp(sender, transferCall(recipient.address, 0n), { initCode });
      op.paymasterAndData = await paymasterAndData(op, pmSigner);
      await sign(op, owner);
      await expect(entryPoint.connect(bundler).handleOps([op], bundler.address))
        .to.be.revertedWithCustomError(entryPoint, 'FailedOp')
        .withArgs(0, 'AA34 signature error');
    });

    it('refuses a sponsorship not signed by the OpenPrivy backend key', async () => {
      const { sender, initCode } = await counterfactual();
      await paymaster.setSponsorshipStatus(sender, true);
      const op = await buildOp(sender, transferCall(recipient.address, 0n), { initCode });
      op.paymasterAndData = await paymasterAndData(op, stranger);
      await sign(op, owner);
      await expect(entryPoint.connect(bundler).handleOps([op], bundler.address))
        .to.be.revertedWithCustomError(entryPoint, 'FailedOp')
        .withArgs(0, 'AA34 signature error');
    });

    it('refuses an expired sponsorship', async () => {
      const { sender, initCode } = await counterfactual();
      await paymaster.setSponsorshipStatus(sender, true);
      const now = (await ethers.provider.getBlock('latest'))!.timestamp;
      const op = await buildOp(sender, transferCall(recipient.address, 0n), { initCode });
      op.paymasterAndData = await paymasterAndData(op, pmSigner, now - 10, 0);
      await sign(op, owner);
      await expect(entryPoint.connect(bundler).handleOps([op], bundler.address))
        .to.be.revertedWithCustomError(entryPoint, 'FailedOp')
        .withArgs(0, 'AA32 paymaster expired or not due');
    });
  });
});
