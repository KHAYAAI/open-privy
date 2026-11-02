import { IsEmail, IsIn, IsString, Length, MaxLength } from 'class-validator';

export class AddGuardianDto {
  @IsString()
  @Length(1, 100)
  name: string;

  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class StartRecoveryDto {
  @IsEmail()
  @MaxLength(254)
  oldAccountEmail: string;
}

export class TokenDto {
  @IsString()
  @Length(43, 43)
  token: string;
}

export class DecisionDto extends TokenDto {
  @IsIn(['approve', 'decline'])
  decision: 'approve' | 'decline';
}
