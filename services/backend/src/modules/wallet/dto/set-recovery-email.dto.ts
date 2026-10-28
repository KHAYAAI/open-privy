import { IsEmail, MaxLength } from 'class-validator';

export class SetRecoveryEmailDto {
  @IsEmail()
  @MaxLength(254)
  recoveryEmail: string;
}
