import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { WorkOsService } from './workos.service';
import { OneTimeStore } from './one-time-store';
import { User } from './entities/user.entity';
import { JwtStrategy } from './strategies/jwt.strategy';
import { jwtConfig } from '../../config/jwt.config';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    PassportModule,
    JwtModule.register(jwtConfig),
  ],
  providers: [AuthService, WorkOsService, JwtStrategy, OneTimeStore],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
