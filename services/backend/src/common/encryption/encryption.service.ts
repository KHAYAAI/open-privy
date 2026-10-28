import { Injectable, Optional, Inject } from '@nestjs/common';
import * as crypto from 'crypto';
import { logger } from '../logger';
import type { MasterKeyMaterial } from './master-key.loader';

/** DI token for the resolved master key material (base64 string). */
export const MASTER_KEY_MATERIAL = 'ENCRYPTION_MASTER_KEY_MATERIAL';

/**
 * Encryption service for sensitive data (private keys).
 *
 * Security model:
 * - Master key stored in AWS Secrets Manager
 * - Rotation without downtime: servers encrypt with the CURRENT key and can
 *   still decrypt with PREVIOUS keys, so live traffic keeps working while
 *   src/scripts/rotate-master-key.ts re-encrypts every wallet.
 * - Per-user key derived from master key + user ID via PBKDF2
 * - AES-256-GCM for authenticated encryption (includes integrity check)
 * - Nonce (IV) randomly generated per encryption
 * - Auth tag prevents tampering
 */
@Injectable()
export class EncryptionService {
  private masterKey: Buffer;
  private previousKeys: Buffer[] = [];
  private readonly ALGORITHM = 'aes-256-gcm';
  private readonly KEY_LENGTH = 32; // 256 bits
  private readonly IV_LENGTH = 16; // 128 bits
  private readonly PBKDF2_ITERATIONS = 100000;
  private readonly AUTH_TAG_LENGTH = 16; // 128 bits

  /**
   * @param provided Master key material, injected by EncryptionModule (which
   * may have resolved it from AWS Secrets Manager). A bare base64 string is
   * treated as the current key with no previous keys. When constructed
   * directly (e.g. in tests) it falls back to the ENCRYPTION_MASTER_KEY env var.
   */
  constructor(
    @Optional() @Inject(MASTER_KEY_MATERIAL) provided?: string | MasterKeyMaterial,
  ) {
    const material: MasterKeyMaterial =
      typeof provided === 'object' && provided !== null
        ? provided
        : { current: provided ?? process.env.ENCRYPTION_MASTER_KEY, previous: [] } as MasterKeyMaterial;
    this.masterKey = this.parseKey(material.current, 'ENCRYPTION_MASTER_KEY');
    this.previousKeys = (material.previous || []).map((k, i) =>
      this.parseKey(k, `ENCRYPTION_MASTER_KEY_PREVIOUS[${i}]`),
    );
    if (this.previousKeys.some((k) => k.equals(this.masterKey))) {
      throw new Error('A previous master key is identical to the current one');
    }
    logger.info(
      `Encryption master key loaded (id ${this.currentKeyId}` +
        (this.previousKeys.length ? `, ${this.previousKeys.length} previous key(s) accepted for decryption)` : ')'),
    );
  }

  /**
   * Must be base64 that decodes to exactly 32 bytes. In production this comes
   * from AWS Secrets Manager (see master-key.loader.ts).
   */
  private parseKey(rawKey: string | undefined, name: string): Buffer {
    if (!rawKey) {
      throw new Error(
        'ENCRYPTION_MASTER_KEY not set. In production provide it via ' +
        'ENCRYPTION_MASTER_KEY_SECRET_ARN (AWS Secrets Manager). Locally set ' +
        'ENCRYPTION_MASTER_KEY to a base64 32-byte key (openssl rand -base64 32).'
      );
    }
    try {
      const key = Buffer.from(rawKey, 'base64');
      if (key.length !== this.KEY_LENGTH) {
        throw new Error(
          `Master key must be exactly ${this.KEY_LENGTH} bytes (${this.KEY_LENGTH * 8} bits). ` +
          `Got ${key.length} bytes.`
        );
      }
      return key;
    } catch (error) {
      throw new Error(`Failed to parse ${name}: ${error.message}`);
    }
  }

  /**
   * Non-secret identifier for a master key (first 16 hex chars of a domain-
   * separated SHA-256). Stored on each wallet row as encryptionKeyId so a
   * rotation can tell which rows still need re-encrypting.
   */
  static keyIdOf(masterKey: Buffer): string {
    return crypto.createHash('sha256').update('openprivy-master-key-id:').update(masterKey).digest('hex').slice(0, 16);
  }

  get currentKeyId(): string {
    return EncryptionService.keyIdOf(this.masterKey);
  }

  get previousKeyIds(): string[] {
    return this.previousKeys.map((k) => EncryptionService.keyIdOf(k));
  }

  /**
   * Derive a per-user encryption key from a master key + user ID
   * (PBKDF2-SHA256, 100k iterations, salt = sha256("openprivy:" + userId)).
   */
  async deriveUserKey(userId: string, masterKey: Buffer = this.masterKey): Promise<Buffer> {
    const userSalt = crypto.createHash('sha256').update(`openprivy:${userId}`).digest();
    return crypto.pbkdf2Sync(masterKey, userSalt, this.PBKDF2_ITERATIONS, this.KEY_LENGTH, 'sha256');
  }

  /**
   * Encrypt with the CURRENT master key. Format: iv:authTag:ciphertext (hex).
   */
  async encrypt(plaintext: string, userId: string): Promise<string> {
    try {
      const userKey = await this.deriveUserKey(userId);
      const iv = crypto.randomBytes(this.IV_LENGTH);
      const cipher = crypto.createCipheriv(this.ALGORITHM, userKey, iv);
      let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
      ciphertext += cipher.final('hex');
      const authTag = cipher.getAuthTag();
      return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext}`;
    } catch (error) {
      logger.error(`Encryption failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Decrypt data from encrypt(), trying the current key first and then any
   * previous keys. GCM authentication makes a wrong key fail deterministically
   * (never a silent wrong plaintext), so trying keys in turn is safe.
   */
  async decrypt(encrypted: string, userId: string): Promise<string> {
    return (await this.decryptWithKeyId(encrypted, userId)).plaintext;
  }

  async decryptWithKeyId(encrypted: string, userId: string): Promise<{ plaintext: string; keyId: string }> {
    const { iv, authTag, ciphertext } = this.parseCiphertext(encrypted);
    for (const key of [this.masterKey, ...this.previousKeys]) {
      try {
        return { plaintext: await this.decryptWith(key, iv, authTag, ciphertext, userId), keyId: EncryptionService.keyIdOf(key) };
      } catch {
        // wrong key (auth tag mismatch): try the next one
      }
    }
    logger.error('Decryption failed under every configured master key');
    throw new Error('Failed to decrypt data (tampering detected or wrong key)');
  }

  /** Decrypt using ONLY the current key; used to verify freshly rotated data. */
  async decryptWithCurrentKeyOnly(encrypted: string, userId: string): Promise<string> {
    const { iv, authTag, ciphertext } = this.parseCiphertext(encrypted);
    try {
      return await this.decryptWith(this.masterKey, iv, authTag, ciphertext, userId);
    } catch {
      throw new Error('Failed to decrypt data under the current master key');
    }
  }

  /**
   * Re-encrypt one record under the current key, decrypting with whichever
   * configured key works. Never mutates service state, so it is safe to run
   * while the same instance serves live traffic.
   */
  async reencryptToCurrentKey(
    encrypted: string,
    userId: string,
  ): Promise<{ ciphertext: string; plaintext: string; fromKeyId: string }> {
    const { plaintext, keyId } = await this.decryptWithKeyId(encrypted, userId);
    return { ciphertext: await this.encrypt(plaintext, userId), plaintext, fromKeyId: keyId };
  }

  private parseCiphertext(encrypted: string): { iv: Buffer; authTag: Buffer; ciphertext: string } {
    const parts = encrypted.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format (expected iv:authTag:ciphertext)');
    }
    const [ivHex, authTagHex, ciphertext] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    if (iv.length !== this.IV_LENGTH) {
      throw new Error(`Invalid IV length: expected ${this.IV_LENGTH}, got ${iv.length}`);
    }
    if (authTag.length !== this.AUTH_TAG_LENGTH) {
      throw new Error(`Invalid auth tag length: expected ${this.AUTH_TAG_LENGTH}, got ${authTag.length}`);
    }
    return { iv, authTag, ciphertext };
  }

  private async decryptWith(
    masterKey: Buffer,
    iv: Buffer,
    authTag: Buffer,
    ciphertext: string,
    userId: string,
  ): Promise<string> {
    const userKey = await this.deriveUserKey(userId, masterKey);
    const decipher = crypto.createDecipheriv(this.ALGORITHM, userKey, iv);
    decipher.setAuthTag(authTag);
    let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');
    return plaintext;
  }

  /** Generate a secure random base64 master key. */
  static generateMasterKey(): string {
    return crypto.randomBytes(32).toString('base64');
  }
}
