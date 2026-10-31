import { ethers } from 'ethers';
import { validateRecipient, validateAmount, isTrustedAuthUrl } from './validation';

describe('validateRecipient', () => {
  const addr = ethers.Wallet.createRandom().address;

  it('accepts a checksummed address and returns it checksummed', () => {
    expect(validateRecipient(addr)).toEqual({ ok: true, value: addr });
  });

  it('accepts all-lowercase and normalizes it', () => {
    expect(validateRecipient(addr.toLowerCase())).toEqual({ ok: true, value: addr });
  });

  it('rejects a mixed-case address with a bad checksum (likely typo)', () => {
    const known = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'; // EIP-55 test vector
    expect(validateRecipient(known).ok).toBe(true);
    const oneCaseFlipped = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
    const r = validateRecipient(oneCaseFlipped);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('typo');
  });

  it('rejects garbage, short input, the zero address, and your own address', () => {
    expect(validateRecipient('hello').ok).toBe(false);
    expect(validateRecipient('0x1234').ok).toBe(false);
    expect(validateRecipient(ethers.ZeroAddress).ok).toBe(false);
    expect(validateRecipient(addr, addr.toLowerCase()).ok).toBe(false);
  });
});

describe('validateAmount', () => {
  it('parses exactly without floating point error', () => {
    const r = validateAmount('0.1');
    expect(r.ok && r.value.wei).toBe(100000000000000000n);
  });

  it('rejects zero, negatives, scientific notation, and too many decimals', () => {
    for (const bad of ['0', '-1', '1e18', '1,5', '0.' + '1'.repeat(19), '']) {
      expect(validateAmount(bad).ok).toBe(false);
    }
  });

  it('rejects more than the balance', () => {
    expect(validateAmount('1.5', '1.0').ok).toBe(false);
    expect(validateAmount('1.0', '1.0').ok).toBe(true);
  });
});

describe('isTrustedAuthUrl', () => {
  it('only allows WorkOS over https', () => {
    expect(isTrustedAuthUrl('https://api.workos.com/user_management/authorize?x=1')).toBe(true);
    expect(isTrustedAuthUrl('https://evil.example/authorize')).toBe(false);
    expect(isTrustedAuthUrl('http://api.workos.com/x')).toBe(false);
    expect(isTrustedAuthUrl('javascript:alert(1)')).toBe(false);
  });
});
