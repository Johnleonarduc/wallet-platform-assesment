import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { DepositDto } from './dto/deposit.dto';
import { TransferDto } from './dto/transfer.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@ApiBearerAuth('bearer')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  create(@Body() dto: CreateWalletDto) {
    return this.walletsService.createWallet(dto);
  }

  @Post('transfer')
  transfer(@Body() dto: TransferDto) {
    return this.walletsService.transfer(dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.walletsService.getWallet(id);
  }

  @Get(':id/dashboard')
  dashboard(@Param('id') id: string) {
    return this.walletsService.getDashboard(id);
  }

  @Post(':id/deposit')
  deposit(@Param('id') id: string, @Body() dto: DepositDto) {
    return this.walletsService.deposit(id, dto);
  }

  @Post(':id/withdraw')
  withdraw(@Param('id') id: string, @Body() dto: WithdrawDto) {
    return this.walletsService.withdraw(id, dto);
  }
}
