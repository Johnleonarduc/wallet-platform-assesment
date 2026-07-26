import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LedgerModule } from '../ledger/ledger.module';
import { LedgerEntry, LedgerEntrySchema } from '../ledger/schemas/ledger-entry.schema';
import { OutboxModule } from '../outbox/outbox.module';
import { Transaction, TransactionSchema } from '../transactions/schemas/transaction.schema';
import { TransactionsModule } from '../transactions/transactions.module';
import { Transfer, TransferSchema } from './schemas/transfer.schema';
import { Wallet, WalletSchema } from './schemas/wallet.schema';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Wallet.name, schema: WalletSchema },
      { name: Transfer.name, schema: TransferSchema },
      { name: Transaction.name, schema: TransactionSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
    ]),
    LedgerModule,
    OutboxModule,
    TransactionsModule,
  ],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
