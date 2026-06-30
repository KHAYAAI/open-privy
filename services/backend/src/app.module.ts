import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AuthModule } from './modules/auth/auth.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { BlockchainModule } from './modules/blockchain/blockchain.module';
import { TransactionModule } from './modules/transactions/transaction.module';
import { HealthController } from './common/health.controller';
import { typeOrmConfig } from './config/typeorm.config';
import { jwtConfig } from './config/jwt.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRoot(typeOrmConfig),
    JwtModule.register(jwtConfig),
    PassportModule,
    AuthModule,
    WalletModule,
    BlockchainModule,
    TransactionModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
