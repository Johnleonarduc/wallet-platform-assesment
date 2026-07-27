import * as bcrypt from 'bcrypt';
import * as mongoose from 'mongoose';
import { User, UserSchema } from '../../src/auth/schemas/user.schema';
import {
  LedgerEntry,
  LedgerEntryDirection,
  LedgerEntrySchema,
} from '../../src/ledger/schemas/ledger-entry.schema';
import {
  OutboxEvent,
  OutboxEventSchema,
  OutboxEventStatus,
} from '../../src/outbox/schemas/outbox-event.schema';
import {
  Transaction,
  TransactionSchema,
  TransactionStatus,
  TransactionType,
} from '../../src/transactions/schemas/transaction.schema';
import {
  Transfer,
  TransferSchema,
  TransferStatus,
} from '../../src/wallets/schemas/transfer.schema';
import { Wallet, WalletSchema } from '../../src/wallets/schemas/wallet.schema';
import { OWNER_NAMES, pick, randomInt } from './data';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/wallet-platform';

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to ${MONGODB_URI}`);

  const UserModel = mongoose.model(User.name, UserSchema);
  const WalletModel = mongoose.model(Wallet.name, WalletSchema);
  const TransactionModel = mongoose.model(Transaction.name, TransactionSchema);
  const LedgerEntryModel = mongoose.model(LedgerEntry.name, LedgerEntrySchema);
  const TransferModel = mongoose.model(Transfer.name, TransferSchema);
  const OutboxEventModel = mongoose.model(OutboxEvent.name, OutboxEventSchema);

  console.log('Clearing existing collections...');
  await Promise.all([
    UserModel.deleteMany({}),
    WalletModel.deleteMany({}),
    TransactionModel.deleteMany({}),
    LedgerEntryModel.deleteMany({}),
    TransferModel.deleteMany({}),
    OutboxEventModel.deleteMany({}),
  ]);

  console.log('Creating demo user...');
  await UserModel.create({
    email: 'demo@wallet-platform.test',
    passwordHash: await bcrypt.hash('Password123!', 10),
    fullName: 'Demo Reviewer',
  });

  console.log('Creating 20 wallets...');
  const wallets = await WalletModel.insertMany(
    OWNER_NAMES.map((ownerName, i) => ({
      userId: `user-${1000 + i}`,
      ownerName,
      currency: 'GHS',
      balance: 0,
      version: 0,
    })),
  );

  console.log('Creating ~500 deposit/withdrawal transactions with ledger entries...');
  const transactionsPerWallet = Math.floor(500 / wallets.length);

  for (const wallet of wallets) {
    let balance = 0;
    const transactionDocs: Record<string, unknown>[] = [];
    const ledgerDocs: Record<string, unknown>[] = [];

    // Every wallet starts with a seeding deposit so withdrawals have room to work with.
    const openingDeposit = randomInt(2000, 8000);
    balance += openingDeposit;

    const openingTxnId = new mongoose.Types.ObjectId();
    transactionDocs.push({
      _id: openingTxnId,
      walletId: wallet._id,
      type: TransactionType.DEPOSIT,
      amount: openingDeposit,
      status: TransactionStatus.COMPLETED,
      balanceAfter: balance,
      reference: `seed-opening-${wallet._id.toString()}`,
    });
    ledgerDocs.push({
      transactionId: openingTxnId,
      walletId: wallet._id,
      direction: LedgerEntryDirection.CREDIT,
      amount: openingDeposit,
      balanceAfter: balance,
    });

    for (let i = 1; i < transactionsPerWallet; i++) {
      const isDeposit = Math.random() > 0.45;
      const amount = randomInt(10, 500);

      if (!isDeposit && balance < amount) {
        continue;
      }

      balance = isDeposit ? balance + amount : balance - amount;
      const txnId = new mongoose.Types.ObjectId();

      transactionDocs.push({
        _id: txnId,
        walletId: wallet._id,
        type: isDeposit ? TransactionType.DEPOSIT : TransactionType.WITHDRAWAL,
        amount,
        status: TransactionStatus.COMPLETED,
        balanceAfter: balance,
        reference: `seed-${wallet._id.toString()}-${i}`,
      });
      ledgerDocs.push({
        transactionId: txnId,
        walletId: wallet._id,
        direction: isDeposit ? LedgerEntryDirection.CREDIT : LedgerEntryDirection.DEBIT,
        amount,
        balanceAfter: balance,
      });
    }

    await TransactionModel.insertMany(transactionDocs);
    await LedgerEntryModel.insertMany(ledgerDocs);
    await WalletModel.updateOne({ _id: wallet._id }, { balance });
    wallet.balance = balance;
  }

  console.log('Creating completed transfers...');
  for (let i = 0; i < 5; i++) {
    const fromWallet = pick(wallets);
    let toWallet = pick(wallets);
    while (toWallet._id.equals(fromWallet._id)) {
      toWallet = pick(wallets);
    }

    const amount = randomInt(20, 200);
    const transfer = await TransferModel.create({
      fromWalletId: fromWallet._id,
      toWalletId: toWallet._id,
      amount,
      status: TransferStatus.COMPLETED,
      idempotencyKey: `seed-transfer-${i}`,
    });

    const debitTxn = await TransactionModel.create({
      walletId: fromWallet._id,
      type: TransactionType.TRANSFER_OUT,
      amount,
      status: TransactionStatus.COMPLETED,
      balanceAfter: fromWallet.balance - amount,
      transferId: transfer._id,
      counterpartyWalletId: toWallet._id,
    });
    await LedgerEntryModel.create({
      transactionId: debitTxn._id,
      walletId: fromWallet._id,
      direction: LedgerEntryDirection.DEBIT,
      amount,
      balanceAfter: fromWallet.balance - amount,
    });
    await WalletModel.updateOne({ _id: fromWallet._id }, { $inc: { balance: -amount } });
    fromWallet.balance -= amount;

    const creditTxn = await TransactionModel.create({
      walletId: toWallet._id,
      type: TransactionType.TRANSFER_IN,
      amount,
      status: TransactionStatus.COMPLETED,
      balanceAfter: toWallet.balance + amount,
      transferId: transfer._id,
      counterpartyWalletId: fromWallet._id,
    });
    await LedgerEntryModel.create({
      transactionId: creditTxn._id,
      walletId: toWallet._id,
      direction: LedgerEntryDirection.CREDIT,
      amount,
      balanceAfter: toWallet.balance + amount,
    });
    await WalletModel.updateOne({ _id: toWallet._id }, { $inc: { balance: amount } });
    toWallet.balance += amount;
  }

  console.log(
    'Creating stuck PENDING transfers (sender already debited, receiver never credited)...',
  );
  for (let i = 0; i < 3; i++) {
    const fromWallet = pick(wallets);
    let toWallet = pick(wallets);
    while (toWallet._id.equals(fromWallet._id)) {
      toWallet = pick(wallets);
    }

    const amount = randomInt(20, 100);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const transfer = await TransferModel.create({
      fromWalletId: fromWallet._id,
      toWalletId: toWallet._id,
      amount,
      status: TransferStatus.PENDING,
      idempotencyKey: `seed-stuck-transfer-${i}`,
      createdAt: twoHoursAgo,
      updatedAt: twoHoursAgo,
    });

    const debitTxn = await TransactionModel.create({
      walletId: fromWallet._id,
      type: TransactionType.TRANSFER_OUT,
      amount,
      status: TransactionStatus.COMPLETED,
      balanceAfter: fromWallet.balance - amount,
      transferId: transfer._id,
      counterpartyWalletId: toWallet._id,
      createdAt: twoHoursAgo,
    });
    await LedgerEntryModel.create({
      transactionId: debitTxn._id,
      walletId: fromWallet._id,
      direction: LedgerEntryDirection.DEBIT,
      amount,
      balanceAfter: fromWallet.balance - amount,
    });
    await WalletModel.updateOne({ _id: fromWallet._id }, { $inc: { balance: -amount } });
    fromWallet.balance -= amount;
  }

  console.log('Creating a FAILED transfer with an un-reversed debit (partial failure incident)...');
  {
    const fromWallet = pick(wallets);
    let toWallet = pick(wallets);
    while (toWallet._id.equals(fromWallet._id)) {
      toWallet = pick(wallets);
    }
    const amount = randomInt(20, 60);

    const transfer = await TransferModel.create({
      fromWalletId: fromWallet._id,
      toWalletId: toWallet._id,
      amount,
      status: TransferStatus.FAILED,
      idempotencyKey: 'seed-failed-transfer-0',
      failureReason: 'Downstream settlement timeout',
    });

    const debitTxn = await TransactionModel.create({
      walletId: fromWallet._id,
      type: TransactionType.TRANSFER_OUT,
      amount,
      status: TransactionStatus.COMPLETED,
      balanceAfter: fromWallet.balance - amount,
      transferId: transfer._id,
      counterpartyWalletId: toWallet._id,
    });
    await LedgerEntryModel.create({
      transactionId: debitTxn._id,
      walletId: fromWallet._id,
      direction: LedgerEntryDirection.DEBIT,
      amount,
      balanceAfter: fromWallet.balance - amount,
    });
    await WalletModel.updateOne({ _id: fromWallet._id }, { $inc: { balance: -amount } });
  }

  console.log('Creating a replayed consumer delivery (credited exactly once)...');
  {
    const fromWallet = pick(wallets);
    let toWallet = pick(wallets);
    while (toWallet._id.equals(fromWallet._id)) {
      toWallet = pick(wallets);
    }
    const amount = randomInt(20, 60);

    const transfer = await TransferModel.create({
      fromWalletId: fromWallet._id,
      toWalletId: toWallet._id,
      amount,
      status: TransferStatus.COMPLETED,
      idempotencyKey: 'seed-duplicate-delivery-0',
    });

    const debitTxn = await TransactionModel.create({
      walletId: fromWallet._id,
      type: TransactionType.TRANSFER_OUT,
      amount,
      status: TransactionStatus.COMPLETED,
      balanceAfter: fromWallet.balance - amount,
      transferId: transfer._id,
      counterpartyWalletId: toWallet._id,
    });
    await LedgerEntryModel.create({
      transactionId: debitTxn._id,
      walletId: fromWallet._id,
      direction: LedgerEntryDirection.DEBIT,
      amount,
      balanceAfter: fromWallet.balance - amount,
    });
    await WalletModel.updateOne({ _id: fromWallet._id }, { $inc: { balance: -amount } });

    // A replay of the same delivery is a no-op after the transfer reaches COMPLETED,
    // so there is only one inbound transaction, ledger credit, and balance update.
    const creditTxn = await TransactionModel.create({
      walletId: toWallet._id,
      type: TransactionType.TRANSFER_IN,
      amount,
      status: TransactionStatus.COMPLETED,
      balanceAfter: toWallet.balance + amount,
      transferId: transfer._id,
      counterpartyWalletId: fromWallet._id,
    });
    await LedgerEntryModel.create({
      transactionId: creditTxn._id,
      walletId: toWallet._id,
      direction: LedgerEntryDirection.CREDIT,
      amount,
      balanceAfter: toWallet.balance + amount,
    });
    await WalletModel.updateOne({ _id: toWallet._id }, { $inc: { balance: amount } });
  }

  console.log('Creating outbox events (mix of published and pending)...');
  const firstWallet = wallets[0];
  await OutboxEventModel.create([
    {
      routingKey: 'wallet.created',
      payload: { walletId: firstWallet._id.toString(), userId: firstWallet.userId },
      status: OutboxEventStatus.PUBLISHED,
      publishedAt: new Date(),
    },
    {
      routingKey: 'wallet.created',
      payload: { walletId: wallets[1]._id.toString(), userId: wallets[1].userId },
      status: OutboxEventStatus.PENDING,
    },
  ]);

  console.log('Seed complete.');
  console.log(`  Wallets: ${await WalletModel.countDocuments()}`);
  console.log(`  Transactions: ${await TransactionModel.countDocuments()}`);
  console.log(`  Ledger entries: ${await LedgerEntryModel.countDocuments()}`);
  console.log(`  Transfers: ${await TransferModel.countDocuments()}`);
  console.log('  Demo login: demo@wallet-platform.test / Password123!');

  await mongoose.disconnect();
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
