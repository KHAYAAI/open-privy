import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { EncryptionService } from '../../src/common/encryption/encryption.service';
import { assertKeyMatchesAddress } from '../../src/common/encryption/key-rotation';

/**
 * Master-key rotation without downtime: servers hold the new key as current
 * and old keys as previous. Old ciphertext keeps decrypting; new writes use
 * the new key; re-encryption never mutates the live service's key.
 * The full database rotation is exercised by scripts/key-rotation-drill.sh.
 */
describe('Master-key rotation', () => {
  const OLD = crypto.randomBytes(32).toString('base64');
  const NEW = crypto.randomBytes(32).toString('base64');
  const userId = crypto.randomUUID();
  const pk = ethers.Wallet.createRandom().privateKey;

  const oldOnly = new EncryptionService({ current: OLD, previous: [] });
  const rotating = new EncryptionService({ current: NEW, previous: [OLD] });
  const newOnly = new EncryptionService({ current: NEW, previous: [] });

  it('gives each key a stable, non-secret id', () => {
    expect(oldOnly.currentKeyId).toMatch(/^[0-9a-f]{16}$/);
    expect(oldOnly.currentKeyId).not.toBe(newOnly.currentKeyId);
    expect(rotating.previousKeyIds).toEqual([oldOnly.currentKeyId]);
    expect(oldOnly.currentKeyId).not.toContain(Buffer.from(OLD, 'base64').toString('hex').slice(0, 16));
  });

  it('during rotation, data under the OLD key still decrypts', async () => {
    const ct = await oldOnly.encrypt(pk, userId);
    await expect(rotating.decrypt(ct, userId)).resolves.toBe(pk);
    await expect(rotating.decryptWithKeyId(ct, userId)).resolves.toEqual({ plaintext: pk, keyId: oldOnly.currentKeyId });
  });

  it('during rotation, NEW writes use the new key', async () => {
    const ct = await rotating.encrypt(pk, userId);
    await expect(newOnly.decrypt(ct, userId)).resolves.toBe(pk);
    await expect(oldOnly.decrypt(ct, userId)).rejects.toThrow();
  });

  it('re-encrypts old data under the current key without changing the plaintext', async () => {
    const oldCt = await oldOnly.encrypt(pk, userId);
    const { ciphertext, plaintext, fromKeyId } = await rotating.reencryptToCurrentKey(oldCt, userId);
    expect(plaintext).toBe(pk);
    expect(fromKeyId).toBe(oldOnly.currentKeyId);
    await expect(newOnly.decrypt(ciphertext, userId)).resolves.toBe(pk);
    await expect(rotating.decryptWithCurrentKeyOnly(ciphertext, userId)).resolves.toBe(pk);
  });

  it('after the old key is retired, un-rotated data no longer decrypts (why the tool must finish first)', async () => {
    const oldCt = await oldOnly.encrypt(pk, userId);
    await expect(newOnly.decrypt(oldCt, userId)).rejects.toThrow('Failed to decrypt');
    await expect(rotating.decryptWithCurrentKeyOnly(oldCt, userId)).rejects.toThrow();
  });

  it('refuses a configuration where a previous key equals the current one', () => {
    expect(() => new EncryptionService({ current: NEW, previous: [NEW] })).toThrow('identical');
  });

  it('rejects a malformed previous key at startup', () => {
    expect(() => new EncryptionService({ current: NEW, previous: ['dG9vLXNob3J0'] })).toThrow('PREVIOUS[0]');
  });

  describe('assertKeyMatchesAddress (guards every rewrite)', () => {
    it('accepts an EVM key that derives the stored address', () => {
      const w = ethers.Wallet.createRandom();
      expect(() => assertKeyMatchesAddress('ethereum', w.privateKey, w.address)).not.toThrow();
    });

    it('rejects an EVM key for a different address', () => {
      expect(() =>
        assertKeyMatchesAddress('polygon', ethers.Wallet.createRandom().privateKey, ethers.Wallet.createRandom().address),
      ).toThrow('does not derive');
    });

    it('accepts a Solana secret key that derives the stored address', () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
      const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
      const secretHex = Buffer.concat([seed, pub]).toString('hex');
      expect(() => assertKeyMatchesAddress('solana', secretHex, ethers.encodeBase58(pub))).not.toThrow();
    });

    it('rejects a Solana secret whose public half was tampered with', () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
      const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
      const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
      const secretHex = Buffer.concat([seed, other]).toString('hex');
      expect(() => assertKeyMatchesAddress('solana', secretHex, ethers.encodeBase58(pub))).toThrow('does not derive');
    });

    it('refuses chains it cannot verify', () => {
      expect(() => assertKeyMatchesAddress('bitcoin', 'x', 'y')).toThrow('refusing to rotate');
    });
  });
});
