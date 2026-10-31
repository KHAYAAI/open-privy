import { ethers } from 'ethers';
import { UserOpService } from '../../src/modules/account-abstraction/userop.service';
import { PaymasterService } from '../../src/modules/account-abstraction/paymaster.service';

jest.mock('../../src/modules/blockchain/ethereum.service', () => ({ EthereumService: jest.fn() }));

/**
 * ON-CHAIN: the backend's UserOpService against a REAL EntryPoint v0.7.
 *
 *  1. Our userOpHash equals EntryPoint.getUserOpHash (view call, no gas).
 *  2. (local chain with OpenPrivy contracts) A sponsored UserOp built and
 *     signed by UserOpService deploys a SimpleAccount via initCode, moves ETH,
 *     and a second op uses the EntryPoint-managed nonce, all via handleOps,
 *     the same call a production bundler makes.
 *
 * Local run (no external RPC needed):
 *   cd services/contracts && npx hardhat node &
 *   AA_ENV_OUT=/tmp/aa.env npx hardhat run scripts/deploy-local-aa.ts --network localhost
 *   cd ../backend && set -a && . /tmp/aa.env && set +a && \
 *     AA_RPC_URL=http://127.0.0.1:8545 npx jest test/integration/userop-hash.integration.test.ts
 *
 * Public testnet: set AA_RPC_URL to a Sepolia RPC (canonical EntryPoint); only
 * test 1 runs unless AA_FACTORY_ADDRESS/AA_PAYMASTER_ADDRESS are also set.
 */
const RPC = process.env.AA_RPC_URL;
const ENTRYPOINT = process.env.ENTRYPOINT_ADDRESS || '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const FACTORY = process.env.AA_FACTORY_ADDRESS;
const PAYMASTER = process.env.AA_PAYMASTER_ADDRESS;

// Hardhat's public dev accounts #0 (bundler) and #1 (paymaster signer); local chain only.
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const hardhatKey = (i: number) =>
  ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).privateKey;
const HARDHAT_KEY_0 = hardhatKey(0);
const HARDHAT_KEY_1 = hardhatKey(1);

const maybe = RPC ? describe : describe.skip;

maybe('UserOpService against a real EntryPoint v0.7', () => {
  jest.setTimeout(60_000);
  const provider = new ethers.JsonRpcProvider(RPC);
  const entryPoint = new ethers.Contract(
    ENTRYPOINT,
    [
      'function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)',
      'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)',
      'function getNonce(address sender, uint192 key) view returns (uint256)',
      'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
    ],
    provider,
  );
  const ethereumService = {
    getProvider: () => provider,
    estimateGas: async () => 21000n,
    getGasPrice: async () => (await provider.getFeeData()).gasPrice ?? 1_000_000_000n,
  };
  const allowAll = { screenAddress: async () => ({ blocked: false }) };

  function makeService(paymasterService: any) {
    process.env.ENTRYPOINT_ADDRESS = ENTRYPOINT;
    return new UserOpService({} as any, ethereumService as any, paymasterService, allowAll as any);
  }

  beforeAll(async () => {
    process.env.CHAIN_ID = (await provider.getNetwork()).chainId.toString();
  });

  it('userOpHash equals EntryPoint.getUserOpHash', async () => {
    const svc = makeService({});
    jest.spyOn(svc as any, 'getNonce').mockResolvedValue(3n);
    const { userOp, userOpHash } = await svc.buildUserOp(
      ethers.Wallet.createRandom().address,
      ethers.Wallet.createRandom().address,
      '0x',
      undefined,
      { sponsor: false },
    );
    expect(userOpHash.toLowerCase()).toBe((await entryPoint.getUserOpHash(userOp)).toLowerCase());
  });

  const local = FACTORY && PAYMASTER ? it : it.skip;

  local('sponsored UserOp built and signed by the backend executes on-chain', async () => {
    const bundlerWallet = new ethers.Wallet(HARDHAT_KEY_0, provider);
    const bundler = new ethers.NonceManager(bundlerWallet);
    const pmSigner = new ethers.Wallet(HARDHAT_KEY_1);
    const owner = ethers.Wallet.createRandom();
    const recipient = ethers.Wallet.createRandom().address;

    const factory = new ethers.Contract(
      FACTORY!,
      ['function getAccountAddress(address owner,uint256 salt) view returns (address)', 'function createAccount(address owner,uint256 salt)'],
      provider,
    );
    const paymaster = new ethers.Contract(
      PAYMASTER!,
      [
        'function getHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)',
        'function setSponsorshipStatus(address account, bool enabled)',
        'function gasSponsored(address) view returns (uint256)',
      ],
      bundler,
    );

    const salt = BigInt(Date.now());
    const sender: string = await factory.getAccountAddress(owner.address, salt);
    const initCode = ethers.concat([FACTORY!, factory.interface.encodeFunctionData('createAccount', [owner.address, salt])]);
    await (await paymaster.setSponsorshipStatus(sender, true)).wait();
    await (await bundler.sendTransaction({ to: sender, value: ethers.parseEther('1') })).wait();

    // Stand-in for Pimlico: OpenPrivyPaymaster sponsorship signed by its signer key.
    const PM_VGL = 150_000n;
    const PM_POGL = 60_000n;
    const paymasterService = {
      sponsorUserOp: async (op: any) => {
        const timestamps = ethers.AbiCoder.defaultAbiCoder().encode(['uint48', 'uint48'], [0, 0]);
        const header = ethers.concat([PAYMASTER!, ethers.toBeHex(PM_VGL, 16), ethers.toBeHex(PM_POGL, 16), timestamps]);
        const draft = { ...op, paymasterAndData: ethers.concat([header, '0x' + '00'.repeat(65)]) };
        const sig = await pmSigner.signMessage(ethers.getBytes(await paymaster.getHash(draft, 0, 0)));
        return PaymasterService.mergeSponsorship(op, {
          paymaster: PAYMASTER,
          paymasterVerificationGasLimit: PM_VGL,
          paymasterPostOpGasLimit: PM_POGL,
          paymasterData: ethers.concat([timestamps, sig]),
        });
      },
    };
    const svc = makeService(paymasterService);

    // Op 1: deploys the account (initCode) and sends 0.1 ETH.
    const first = await svc.buildUserOp(sender, recipient, '0x', '21000', {
      value: ethers.parseEther('0.1'),
      initCode,
    });
    expect(first.userOp.nonce).toBe('0'); // real EntryPoint.getNonce, not mocked
    expect(first.userOpHash.toLowerCase()).toBe((await entryPoint.getUserOpHash(first.userOp)).toLowerCase());
    await svc.signUserOp(first.userOp, owner.privateKey);

    const balanceBefore = await provider.getBalance(sender);
    const receipt = await (await (entryPoint.connect(bundler) as any).handleOps([first.userOp], bundlerWallet.address)).wait();
    const evt = receipt.logs.map((l: any) => { try { return entryPoint.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === 'UserOperationEvent');
    expect(evt.args.success).toBe(true);
    expect(evt.args.paymaster.toLowerCase()).toBe(PAYMASTER!.toLowerCase());

    expect(await provider.getCode(sender)).not.toBe('0x');
    expect(await provider.getBalance(recipient)).toBe(ethers.parseEther('0.1'));
    // Sponsored: the account paid the transfer value and zero gas.
    expect(await provider.getBalance(sender)).toBe(balanceBefore - ethers.parseEther('0.1'));
    expect(await paymaster.gasSponsored(sender)).toBeGreaterThan(0n);

    // Op 2: account already deployed; nonce comes from the EntryPoint.
    const second = await svc.buildUserOp(sender, recipient, '0x', '21000', { value: ethers.parseEther('0.05') });
    expect(second.userOp.nonce).toBe('1');
    await svc.signUserOp(second.userOp, owner.privateKey);
    await (await (entryPoint.connect(bundler) as any).handleOps([second.userOp], bundlerWallet.address)).wait();
    expect(await provider.getBalance(recipient)).toBe(ethers.parseEther('0.15'));
    expect(await entryPoint.getNonce(sender, 0)).toBe(2n);
  });
});
