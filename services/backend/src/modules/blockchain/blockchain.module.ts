import { Module } from '@nestjs/common';
import { EthereumService } from './ethereum.service';
import { BlockchainController } from './blockchain.controller';

@Module({
  providers: [EthereumService],
  controllers: [BlockchainController],
  exports: [EthereumService],
})
export class BlockchainModule {}
