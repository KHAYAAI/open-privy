import { Controller, Get, Param, Query } from '@nestjs/common';
import { EthereumService } from './ethereum.service';

@Controller('blockchain')
export class BlockchainController {
  constructor(private ethereumService: EthereumService) {}

  @Get('balance/:address')
  async getBalance(@Param('address') address: string) {
    const balance = await this.ethereumService.getBalance(address);
    return {
      address,
      balance: balance.toString(),
      balanceEth: Math.floor((Number(balance) / 1e18) * 1000000) / 1000000,
    };
  }

  @Get('gas-price')
  async getGasPrice() {
    const gasPrice = await this.ethereumService.getGasPrice();
    return {
      gasPrice: gasPrice.toString(),
      gasPriceGwei: Math.floor((Number(gasPrice) / 1e9) * 1000) / 1000,
    };
  }

  @Get('tx-history/:address')
  async getTransactionHistory(
    @Param('address') address: string,
    @Query('limit') limit?: string,
  ) {
    const txLimit = limit ? parseInt(limit, 10) : 10;
    const history = await this.ethereumService.getTransactionHistory(address, txLimit);
    return {
      address,
      count: history.length,
      transactions: history,
    };
  }

  @Get('tx-receipt/:txHash')
  async getTransactionReceipt(@Param('txHash') txHash: string) {
    const receipt = await this.ethereumService.getTransactionReceipt(txHash);
    return receipt;
  }
}
