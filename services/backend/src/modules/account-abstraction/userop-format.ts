import { ethers } from 'ethers';

/** EntryPoint v0.7 PackedUserOperation: the on-chain layout that gets hashed. */
export interface PackedUserOp {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  accountGasLimits: string; // verificationGasLimit (hi 128) | callGasLimit (lo 128)
  preVerificationGas: string;
  gasFees: string; // maxPriorityFeePerGas (hi 128) | maxFeePerGas (lo 128)
  paymasterAndData: string; // paymaster(20) | pmVerificationGas(16) | pmPostOpGas(16) | paymasterData
  signature: string;
}

/** ERC-7769 JSON-RPC shape that v0.7 bundlers (eth_sendUserOperation) and paymasters accept. */
export interface RpcUserOp {
  sender: string;
  nonce: string;
  factory?: string;
  factoryData?: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster?: string;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
  paymasterData?: string;
  signature: string;
}

/** A 65-byte placeholder signature for gas estimation / sponsorship simulation. */
export const DUMMY_SIGNATURE = ethers.concat([
  '0x' + 'ff'.repeat(15) + 'f0' + '00'.repeat(16), // r
  '0x7a' + 'aa'.repeat(31), // s (below secp256k1n/2)
  '0x1c', // v
]);
if (ethers.dataLength(DUMMY_SIGNATURE) !== 65) throw new Error('DUMMY_SIGNATURE must be 65 bytes');

const MAX_UINT128 = (1n << 128n) - 1n;
const q = (v: bigint | string | number) => ethers.toQuantity(BigInt(v));

export function pack128(hi: bigint, lo: bigint): string {
  if (hi < 0n || lo < 0n || hi > MAX_UINT128 || lo > MAX_UINT128) {
    throw new Error('value does not fit in uint128');
  }
  return ethers.solidityPacked(['uint128', 'uint128'], [hi, lo]);
}

export function unpack128(packed: string): [bigint, bigint] {
  const b = ethers.getBytes(packed);
  if (b.length !== 32) throw new Error(`expected bytes32, got ${b.length} bytes`);
  return [BigInt(ethers.hexlify(b.slice(0, 16))), BigInt(ethers.hexlify(b.slice(16, 32)))];
}

export function packPaymasterAndData(
  paymaster: string,
  verificationGasLimit: bigint,
  postOpGasLimit: bigint,
  paymasterData: string,
): string {
  return ethers.concat([
    ethers.getAddress(paymaster),
    ethers.toBeHex(verificationGasLimit, 16),
    ethers.toBeHex(postOpGasLimit, 16),
    paymasterData || '0x',
  ]);
}

export function toRpcUserOp(op: PackedUserOp): RpcUserOp {
  const [verificationGasLimit, callGasLimit] = unpack128(op.accountGasLimits);
  const [maxPriorityFeePerGas, maxFeePerGas] = unpack128(op.gasFees);
  const rpc: RpcUserOp = {
    sender: ethers.getAddress(op.sender),
    nonce: q(op.nonce),
    callData: op.callData,
    callGasLimit: q(callGasLimit),
    verificationGasLimit: q(verificationGasLimit),
    preVerificationGas: q(op.preVerificationGas),
    maxFeePerGas: q(maxFeePerGas),
    maxPriorityFeePerGas: q(maxPriorityFeePerGas),
    signature: op.signature,
  };

  const initCode = ethers.getBytes(op.initCode || '0x');
  if (initCode.length > 0) {
    if (initCode.length < 20) throw new Error('initCode shorter than a factory address');
    rpc.factory = ethers.getAddress(ethers.hexlify(initCode.slice(0, 20)));
    rpc.factoryData = ethers.hexlify(initCode.slice(20));
  }

  const pmd = ethers.getBytes(op.paymasterAndData || '0x');
  if (pmd.length > 0) {
    if (pmd.length < 52) throw new Error('paymasterAndData shorter than the v0.7 52-byte header');
    rpc.paymaster = ethers.getAddress(ethers.hexlify(pmd.slice(0, 20)));
    rpc.paymasterVerificationGasLimit = q(ethers.hexlify(pmd.slice(20, 36)));
    rpc.paymasterPostOpGasLimit = q(ethers.hexlify(pmd.slice(36, 52)));
    rpc.paymasterData = ethers.hexlify(pmd.slice(52));
  }
  return rpc;
}

export function fromRpcUserOp(rpc: RpcUserOp): PackedUserOp {
  return {
    sender: ethers.getAddress(rpc.sender),
    nonce: BigInt(rpc.nonce).toString(),
    initCode: rpc.factory ? ethers.concat([rpc.factory, rpc.factoryData || '0x']) : '0x',
    callData: rpc.callData,
    accountGasLimits: pack128(BigInt(rpc.verificationGasLimit), BigInt(rpc.callGasLimit)),
    preVerificationGas: BigInt(rpc.preVerificationGas).toString(),
    gasFees: pack128(BigInt(rpc.maxPriorityFeePerGas), BigInt(rpc.maxFeePerGas)),
    paymasterAndData: rpc.paymaster
      ? packPaymasterAndData(
          rpc.paymaster,
          BigInt(rpc.paymasterVerificationGasLimit || 0),
          BigInt(rpc.paymasterPostOpGasLimit || 0),
          rpc.paymasterData || '0x',
        )
      : '0x',
    signature: rpc.signature,
  };
}

const accountIface = new ethers.Interface([
  'function execute(address dest, uint256 value, bytes func)',
  'function executeBatch(address[] dest, uint256[] value, bytes[] func)',
]);
const erc20Iface = new ethers.Interface([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
]);

/**
 * Every address a SimpleAccount UserOp would send value to or authorize:
 * each call target, plus the recipient/spender of ERC-20 transfer/approve/
 * transferFrom inner calls. Throws on calldata it cannot interpret, because
 * screening an opaque blob is no screening at all.
 */
export function extractDestinations(accountCallData: string): string[] {
  let calls: Array<{ to: string; data: string }>;
  const selector = ethers.dataSlice(accountCallData, 0, 4);
  if (selector === accountIface.getFunction('execute')!.selector) {
    const [dest, , func] = accountIface.decodeFunctionData('execute', accountCallData);
    calls = [{ to: dest, data: func }];
  } else if (selector === accountIface.getFunction('executeBatch')!.selector) {
    const [dests, , funcs] = accountIface.decodeFunctionData('executeBatch', accountCallData);
    calls = (dests as string[]).map((to, i) => ({ to, data: (funcs as string[])[i] }));
  } else {
    throw new Error('Unsupported account callData: only execute/executeBatch can be screened');
  }

  const out = new Set<string>();
  for (const c of calls) {
    out.add(ethers.getAddress(c.to));
    if (ethers.dataLength(c.data) >= 4) {
      const parsed = erc20Iface.parseTransaction({ data: c.data });
      if (parsed?.name === 'transfer' || parsed?.name === 'approve') out.add(ethers.getAddress(parsed.args[0]));
      if (parsed?.name === 'transferFrom') {
        out.add(ethers.getAddress(parsed.args[0]));
        out.add(ethers.getAddress(parsed.args[1]));
      }
    }
  }
  return [...out];
}

export function encodeExecute(dest: string, value: bigint, data: string): string {
  return accountIface.encodeFunctionData('execute', [dest, value, data || '0x']);
}
