import * as graphene from 'graphene-pk11';
import { ethers } from 'ethers';
import { logger } from '../logger';

const SECP256K1_ORDER = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);

/**
 * An ethers-SigningKey-shaped adapter backed by a non-extractable PKCS#11 key.
 *
 * ethers' BaseWallet only requires its "signingKey" argument to expose
 * `publicKey` and a `sign(digest)` method — it doesn't care whether that key
 * material lives in software or hardware. Passing an instance of this class
 * to `new ethers.BaseWallet(hsmSigningKey, provider)` reuses ALL of ethers'
 * own transaction-building, serialization and address-derivation logic
 * (signTransaction, signMessage, signTypedData, sendTransaction via
 * AbstractSigner) — only the final digest-signing step is substituted.
 *
 * The private key never leaves the token: it was generated there as
 * `extractable: false`, and this class only ever asks the token to sign a
 * 32-byte digest and hands back the raw (r, s) it returns.
 */
export class HsmSigningKey {
  readonly publicKey: string;
  private readonly session: graphene.Session;
  private readonly privateKeyHandle: graphene.PrivateKey;

  private constructor(
    session: graphene.Session,
    privateKeyHandle: graphene.PrivateKey,
    publicKey: string,
  ) {
    this.session = session;
    this.privateKeyHandle = privateKeyHandle;
    this.publicKey = publicKey;
  }

  /**
   * Generate a new non-extractable secp256k1 keypair on the token, labeled
   * for later lookup via `load()`. Returns the adapter plus the uncompressed
   * public key the caller needs to derive and store the wallet's address.
   */
  static generate(session: graphene.Session, label: string): HsmSigningKey {
    const secp256k1 = graphene.NamedCurve.getByName('secp256k1');

    const { privateKey, publicKey } = session.generateKeyPair(
      graphene.KeyGenMechanism.EC,
      {
        keyType: graphene.KeyType.ECDSA,
        label,
        token: true,
        verify: true,
        paramsEC: secp256k1.value,
      },
      {
        keyType: graphene.KeyType.ECDSA,
        label,
        token: true,
        sign: true,
        private: true,
        sensitive: true,
        extractable: false,
      },
    );

    const pubKeyHex = extractUncompressedPublicKey(publicKey);
    logger.info(`Generated non-extractable HSM key "${label}"`);
    return new HsmSigningKey(session, privateKey as graphene.PrivateKey, pubKeyHex);
  }

  /** Look up a previously generated key by label for signing. */
  static load(session: graphene.Session, label: string): HsmSigningKey {
    const privateObjects = session.find({ label, class: graphene.ObjectClass.PRIVATE_KEY });
    const publicObjects = session.find({ label, class: graphene.ObjectClass.PUBLIC_KEY });

    if (privateObjects.length === 0 || publicObjects.length === 0) {
      throw new Error(`No HSM key found with label "${label}"`);
    }

    const privateKey = privateObjects.items(0).toType<graphene.PrivateKey>();
    const publicKey = publicObjects.items(0).toType<graphene.PublicKey>();
    const pubKeyHex = extractUncompressedPublicKey(publicKey);

    return new HsmSigningKey(session, privateKey, pubKeyHex);
  }

  /**
   * Sign a 32-byte digest. Normalizes to low-S (Ethereum's canonical form —
   * PKCS#11's CKM_ECDSA does not guarantee this) and brute-forces the
   * recovery id by trial-recovering against the token's own public key,
   * since PKCS#11 ECDSA signing returns only (r, s), never v.
   */
  sign(digest: ethers.BytesLike): ethers.Signature {
    const digestBytes = Buffer.from(ethers.getBytes(digest));
    if (digestBytes.length !== 32) {
      throw new Error(`HSM sign() requires a 32-byte digest, got ${digestBytes.length}`);
    }

    const sign = this.session.createSign('ECDSA', this.privateKeyHandle);
    const rawSig: Buffer = sign.once(digestBytes);

    const r = BigInt('0x' + rawSig.subarray(0, 32).toString('hex'));
    let s = BigInt('0x' + rawSig.subarray(32, 64).toString('hex'));

    if (s > SECP256K1_ORDER / 2n) {
      s = SECP256K1_ORDER - s;
    }

    const rHex = '0x' + r.toString(16).padStart(64, '0');
    const sHex = '0x' + s.toString(16).padStart(64, '0');

    for (const v of [27, 28]) {
      const recovered = ethers.recoverAddress(digestBytes, { r: rHex, s: sHex, v });
      if (recovered.toLowerCase() === ethers.computeAddress(this.publicKey).toLowerCase()) {
        return ethers.Signature.from({ r: rHex, s: sHex, v });
      }
    }

    throw new Error('HSM signature did not recover to the token public key under either parity');
  }
}

/**
 * PKCS#11's EC_POINT attribute is a DER OCTET STRING wrapping the raw point
 * (0x04 <len> <0x04 || X || Y>). Strip the 2-byte ASN.1 header (short-form
 * length only — true for a 65-byte secp256k1 point) to get the raw
 * uncompressed point ethers.computeAddress/BaseWallet expect.
 */
function extractUncompressedPublicKey(publicKey: graphene.PublicKey): string {
  const attr = publicKey.getAttribute({ pointEC: null }) as { pointEC: Buffer };
  let point = attr.pointEC;

  if (point[0] === 0x04 && point.length > 65) {
    const len = point[1];
    point = point.subarray(2, 2 + len);
  }

  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error(`Unexpected EC point format/length from token (len=${point.length})`);
  }

  return '0x' + point.toString('hex');
}
