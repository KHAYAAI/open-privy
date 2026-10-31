import { logger } from '../logger';

/**
 * The current master key (encrypts everything new) plus any previous keys
 * still accepted for decryption while a rotation is in progress.
 */
export interface MasterKeyMaterial {
  current: string;
  previous: string[];
}

/**
 * Resolve the encryption master key(s) at boot.
 *
 * Priority:
 *  1. AWS Secrets Manager, when ENCRYPTION_MASTER_KEY_SECRET_ARN is set. This is
 *     the production path: the pod reads it at startup using its IAM role
 *     (IRSA). The secret value may be the raw base64 key, or JSON:
 *       { "ENCRYPTION_MASTER_KEY": "<current>",
 *         "ENCRYPTION_MASTER_KEY_PREVIOUS": ["<old>", ...] }   (during rotation)
 *  2. ENCRYPTION_MASTER_KEY (+ optional comma-separated
 *     ENCRYPTION_MASTER_KEY_PREVIOUS) env vars, for local development / CI.
 *
 * The AWS SDK is imported dynamically so it is only loaded when actually used.
 */
export async function loadMasterKey(): Promise<MasterKeyMaterial> {
  const secretArn = process.env.ENCRYPTION_MASTER_KEY_SECRET_ARN;

  if (secretArn) {
    logger.info('Loading encryption master key from AWS Secrets Manager');
    const { SecretsManagerClient, GetSecretValueCommand } = await import(
      '@aws-sdk/client-secrets-manager'
    );
    const client = new SecretsManagerClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));

    if (!res.SecretString) {
      throw new Error('Secrets Manager secret has no string value');
    }
    return extractKeyMaterial(res.SecretString);
  }

  const envKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!envKey) {
    throw new Error(
      'No master key configured. Set ENCRYPTION_MASTER_KEY_SECRET_ARN ' +
        '(production) or ENCRYPTION_MASTER_KEY (local).',
    );
  }
  return { current: envKey, previous: splitList(process.env.ENCRYPTION_MASTER_KEY_PREVIOUS) };
}

/** Accept either a raw key string or a JSON blob { ENCRYPTION_MASTER_KEY, ENCRYPTION_MASTER_KEY_PREVIOUS? }. */
export function extractKeyMaterial(secretString: string): MasterKeyMaterial {
  try {
    const parsed = JSON.parse(secretString);
    if (parsed && typeof parsed.ENCRYPTION_MASTER_KEY === 'string') {
      const prev = parsed.ENCRYPTION_MASTER_KEY_PREVIOUS;
      return {
        current: parsed.ENCRYPTION_MASTER_KEY,
        previous: Array.isArray(prev) ? prev.filter((k) => typeof k === 'string' && k) : splitList(prev),
      };
    }
  } catch {
    // Not JSON: treat the whole string as the key.
  }
  return { current: secretString, previous: [] };
}

/** Back-compat helper: just the current key. */
export function extractKey(secretString: string): string {
  return extractKeyMaterial(secretString).current;
}

function splitList(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
