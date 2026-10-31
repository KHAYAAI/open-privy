import { IsString, IsIn, IsOptional } from 'class-validator';

export class CreateWalletDto {
  @IsString()
  @IsIn(['ethereum', 'solana', 'polygon', 'arbitrum'])
  chain: string;

  // Defaults to 'software' (AES-256-GCM key encrypted in the database).
  // 'hsm' generates a non-extractable key on a configured PKCS#11 token
  // instead — ethereum/polygon only, and only when PKCS11_MODULE_PATH is set.
  @IsOptional()
  @IsString()
  @IsIn(['software', 'hsm'])
  signingMode?: 'software' | 'hsm';
}
