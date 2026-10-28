import { ethers } from 'ethers';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validates an EVM recipient. Mixed-case input must carry a valid EIP-55
 * checksum (catches typos); all-lowercase is accepted. Returns the
 * checksummed form so the review screen shows exactly what will be signed.
 */
export function validateRecipient(input: string, ownAddress?: string): Result<string> {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Enter the recipient address.' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return { ok: false, error: 'That is not an Ethereum address. It should start with 0x followed by 40 characters.' };
  }
  let address: string;
  try {
    address = ethers.getAddress(raw);
  } catch {
    return { ok: false, error: 'This address has a typo (its checksum does not match). Copy it again from the recipient.' };
  }
  if (address === ethers.ZeroAddress) return { ok: false, error: 'Sending to the zero address would destroy the funds.' };
  if (ownAddress && address.toLowerCase() === ownAddress.toLowerCase()) {
    return { ok: false, error: 'That is your own wallet address.' };
  }
  return { ok: true, value: address };
}

/** Parses an ETH amount exactly (no floating point) and checks it against the balance. */
export function validateAmount(input: string, balanceEth?: string): Result<{ wei: bigint; eth: string }> {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Enter an amount.' };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { ok: false, error: 'Use digits and an optional decimal point, like 0.05.' };
  if ((raw.split('.')[1] || '').length > 18) return { ok: false, error: 'ETH supports at most 18 decimal places.' };
  const wei = ethers.parseEther(raw);
  if (wei <= 0n) return { ok: false, error: 'The amount must be more than zero.' };
  if (balanceEth !== undefined) {
    let balanceWei: bigint;
    try {
      balanceWei = ethers.parseEther(balanceEth);
    } catch {
      balanceWei = -1n;
    }
    if (balanceWei >= 0n && wei > balanceWei) {
      return { ok: false, error: `That is more than your balance of ${balanceEth} ETH.` };
    }
  }
  return { ok: true, value: { wei, eth: ethers.formatEther(wei) } };
}

/** Only follow sign-in redirects to WorkOS over HTTPS (or a local dev backend). */
export function isTrustedAuthUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && (u.hostname === 'api.workos.com' || u.hostname.endsWith('.authkit.app'))) return true;
    return process.env.NODE_ENV !== 'production' && u.protocol === 'http:' && u.hostname === 'localhost';
  } catch {
    return false;
  }
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
