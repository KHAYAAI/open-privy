import { JwtModuleOptions, JwtSignOptions } from '@nestjs/jwt';
import { getJwtSecret } from './secrets';

/** Accepts seconds ("3600") or a duration like "15m", "24h", "7d"; refuses anything else at boot. */
export function parseJwtExpiration(raw: string | undefined): JwtSignOptions['expiresIn'] {
  const value = (raw || '24h').trim();
  if (/^\d+$/.test(value)) return Number(value);
  if (/^\d+(ms|s|m|h|d|w|y)$/.test(value)) return value as JwtSignOptions['expiresIn'];
  throw new Error(`JWT_EXPIRATION must be seconds or a duration like 24h, got "${value}"`);
}

export const jwtConfig: JwtModuleOptions = {
  secret: getJwtSecret(),
  signOptions: {
    expiresIn: parseJwtExpiration(process.env.JWT_EXPIRATION),
  },
};
