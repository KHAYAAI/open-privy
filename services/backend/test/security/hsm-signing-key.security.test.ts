import * as graphene from 'graphene-pk11';
import { ethers } from 'ethers';
import { HsmSigningKey } from '../../src/common/signing/hsm-signing-key';

/**
 * Verifies HsmSigningKey against a REAL PKCS#11 implementation (SoftHSM2
 * locally/in CI; the same code path talks to CloudHSM/Luna/YubiHSM in
 * production — only the module path changes). Not a mock: the key is
 * genuinely generated non-extractable on the token, and the token genuinely
 * performs the signing operation.
 *
 * Requires PKCS11_TEST_MODULE_PATH (defaults to the standard SoftHSM2 install
 * location) and PKCS11_TEST_PIN. Skips cleanly if no PKCS#11 module is found
 * at that path — this repo's CI does not install SoftHSM2 yet, so this is
 * currently exercised locally, not in CI. Flagged here rather than silently
 * assumed covered.
 */
import { existsSync } from 'fs';

const MODULE_PATH =
  process.env.PKCS11_TEST_MODULE_PATH || '/usr/lib/softhsm/libsofthsm2.so';
const PIN = process.env.PKCS11_TEST_PIN || '1234';

const modulePresent = existsSync(MODULE_PATH);
const maybe = modulePresent ? describe : describe.skip;

if (!modulePresent) {
  // eslint-disable-next-line no-console
  console.warn(
    `[hsm-signing-key] Skipping: no PKCS#11 module at ${MODULE_PATH}. ` +
      `Install SoftHSM2 (or set PKCS11_TEST_MODULE_PATH) to run this against real PKCS#11.`,
  );
}

maybe('HsmSigningKey (real PKCS#11 / SoftHSM2)', () => {
  let module: graphene.Module;
  let session: graphene.Session;

  beforeAll(() => {
    module = graphene.Module.load(MODULE_PATH, 'OpenPrivyTest');
    module.initialize();
    const slots = module.getSlots(true);
    if (slots.length === 0) {
      throw new Error('No PKCS#11 slot with a present token — run softhsm2-util --init-token first');
    }
    session = slots.items(0).open(
      graphene.SessionFlag.RW_SESSION | graphene.SessionFlag.SERIAL_SESSION,
    );
    session.login(PIN);
  });

  afterAll(() => {
    session?.logout();
    session?.close();
    module?.finalize();
  });

  it('generates a non-extractable secp256k1 key whose address is derivable from its public key', () => {
    const label = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = HsmSigningKey.generate(session, label);

    expect(key.publicKey).toMatch(/^0x04[0-9a-f]{128}$/);
    const address = ethers.computeAddress(key.publicKey);
    expect(ethers.isAddress(address)).toBe(true);
  });

  it('signs a digest such that the signature recovers to the token-derived address', () => {
    const label = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = HsmSigningKey.generate(session, label);
    const address = ethers.computeAddress(key.publicKey);

    const digest = ethers.getBytes(ethers.id('hsm-signing-key test message'));
    const signature = key.sign(digest);

    const recovered = ethers.recoverAddress(digest, signature);
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());
  });

  it('produces a low-S signature (Ethereum canonical form)', () => {
    const label = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = HsmSigningKey.generate(session, label);
    const digest = ethers.getBytes(ethers.id('low-s check'));
    const signature = key.sign(digest);

    const N = BigInt(
      '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
    );
    expect(BigInt(signature.s)).toBeLessThanOrEqual(N / 2n);
  });

  it('load() finds a previously generated key by label and signs identically to the original handle', () => {
    const label = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const original = HsmSigningKey.generate(session, label);
    const loaded = HsmSigningKey.load(session, label);

    expect(loaded.publicKey).toBe(original.publicKey);

    const digest = ethers.getBytes(ethers.id('load() consistency check'));
    const sig = loaded.sign(digest);
    const address = ethers.computeAddress(original.publicKey);
    expect(ethers.recoverAddress(digest, sig).toLowerCase()).toBe(address.toLowerCase());
  });

  it('throws a clear error for a label that was never generated', () => {
    expect(() => HsmSigningKey.load(session, 'never-existed-label')).toThrow(/No HSM key found/);
  });

  it('rejects a digest that is not exactly 32 bytes', () => {
    const label = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = HsmSigningKey.generate(session, label);
    expect(() => key.sign(new Uint8Array(16))).toThrow(/32-byte digest/);
  });
});
