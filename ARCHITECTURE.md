# Architecture

This document describes how the Wallet Platform is put together today: the
services it depends on, how requests flow through the system, and how the
modules communicate with each other. It is a description of the current
system, not a design proposal.

## System context

```
                                   ┌───────────────────┐
                                   │      Clients       │
                                   │ (merchant backends, │
                                   │  internal tooling)  │
                                   └─────────┬──────────┘
                                             │ HTTPS (JWT bearer)
                                             ▼
                                   ┌───────────────────┐
                                   │   Wallet Platform   │
                                   │     (NestJS API)    │
                                   └──┬──────┬──────┬───┘
                         reads/writes │      │      │ publishes
                             ┌────────┘      │      └────────┐
                             ▼               ▼               ▼
                      ┌────────────┐  ┌────────────┐  ┌──────────────┐
                      │  MongoDB    │  │   Redis     │  │   RabbitMQ    │
                      │ (source of  │  │ (balance    │  │ (domain       │
                      │  truth)     │  │  cache)     │  │  events)      │
                      └────────────┘  └────────────┘  └──────┬───────┘
                                                              │ consumes
                                                              ▼
                                                     ┌───────────────────┐
                                                     │ Background workers │
                                                     │ (in-process, same   │
                                                     │  Nest application)  │
                                                     └───────────────────┘
```

The API, the RabbitMQ consumers, and the background workers all run inside
the same NestJS process (see `main.ts`). There is no separate worker
deployment today - `WorkersModule` and `QueueModule` are wired into the same
`AppModule` as the HTTP controllers.

## Request pipeline

Every inbound HTTP request passes through, in order:

1. `CorrelationIdMiddleware` - stamps `X-Correlation-Id` on the request/response
   and establishes an async-local context for downstream work.
2. `ApiHeadersGuard`-equivalent auth: the global `JwtAuthGuard` (backed by
   `passport-jwt`), which every route requires unless annotated with
   `@Public()` (used by `POST /auth/login` and `GET /health`).
3. The global `ValidationPipe` (`transform: true`, `whitelist: true`),
   which validates and coerces the DTO for the matched route.
4. The controller/service for the module that owns the route.
5. `LoggingInterceptor` logs correlation ID, method, path, and duration on the
   way out.
6. `AllExceptionsFilter` catches anything thrown along the way and renders a
   consistent JSON error body.

## Modules

```
src/
├── app.module.ts        # wires every feature module + global providers
├── auth/                 # JWT login, guard, strategy, User schema
├── wallets/              # wallet CRUD, deposit, withdraw, transfer, dashboard
├── transactions/         # append-only transaction records + listing API
├── ledger/                # double-entry ledger entries (debit/credit)
├── outbox/                # transactional outbox for domain events
├── queue/                 # RabbitMQ publisher + transfer event consumer
├── workers/               # in-process background workers (interval based)
├── redis/                 # wallet balance cache client
├── health/                # liveness/readiness endpoint
├── config/                # typed configuration loader
└── common/                # cross-cutting filters, interceptors, middleware
```

### Wallets

`WalletsService` is the primary write path for money movement. It depends on
`TransactionsService` (records an immutable transaction per operation),
`LedgerService` (records the corresponding debit/credit ledger entries),
`OutboxService` (durable, transactional event staging), `RabbitMQService`
(direct publishing), and `RedisService` (balance cache).

- `POST /wallets` creates a wallet and stages a `wallet.created` outbox event
  in the same MongoDB transaction as the wallet document.
- `POST /wallets/:id/deposit` / `POST /wallets/:id/withdraw` update the
  wallet balance and record a matching transaction + ledger entry.
- `POST /wallets/transfer` moves money between two wallets. It debits the
  sending wallet, records the transaction/ledger entry, and publishes a
  `transfer.initiated` event to RabbitMQ so the receiving side can be
  credited asynchronously.
- `GET /wallets/:id` reads through Redis, falling back to MongoDB.
- `GET /wallets/:id/dashboard` returns a wallet summary alongside its
  transaction and ledger history.

### Transactions & Ledger

Every money movement produces one `Transaction` document (the operation
record) and one or more `LedgerEntry` documents (the double-entry
bookkeeping record: a `DEBIT` or `CREDIT` against a specific wallet, with the
resulting `balanceAfter`). `GET /transactions` supports filtering by wallet
and type with pagination.

### Outbox

`OutboxService` persists an `OutboxEvent` document (`routingKey` + `payload`)
in the same MongoDB transaction as the domain write that produced it.
`OutboxRelayWorker` polls for `PENDING` events on an interval, publishes them
to RabbitMQ via `RabbitMQService`, and marks them `PUBLISHED`. The payload also
persists the originating correlation ID so the relay can restore diagnostic
context after an arbitrary delay or process restart.

### Queue

`RabbitMQService` owns a single `amqp-connection-manager` connection and
channel, declares the `wallet.events` topic exchange and the
`transfer.events.queue` queue (bound to `transfer.*`), and exposes a
`publish(routingKey, payload)` method used by the outbox relay worker. It copies
the persisted correlation ID into the AMQP message properties.

`TransferEventsConsumer` subscribes to `transfer.events.queue` on startup and,
for each `transfer.initiated` message, restores its correlation context,
credits the destination wallet,
records the corresponding transaction/ledger entry, and marks the transfer
`COMPLETED`.

### Workers

Three interval-based workers run inside the API process:

- `OutboxRelayWorker` - drains pending outbox events to RabbitMQ.
- `PendingTransferWorker` - transactionally enqueues spaced, bounded recovery
  events for transfers that remain `PENDING` past a configurable timeout. It
  flags exhausted transfers for manual review without refunding while a valid
  settlement event may still be in flight.
- `WalletEventsWorker` - periodically loads a lean projection of the most
  recently updated wallets and emits snapshots through one process-wide event
  listener, which is registered once and removed during shutdown.

### Redis

`RedisService` wraps a single `ioredis` client and exposes
`getCachedBalance` / `setCachedBalance` / `invalidateBalance`, keyed per
wallet (`wallet:balance:<id>`) with a configurable TTL.

### Auth

`AuthModule` issues JWTs from `POST /auth/login` against the `User`
collection (bcrypt-hashed passwords). `JwtAuthGuard` is registered globally
via `APP_GUARD` and enforced on every route except those annotated
`@Public()`.

## Data model

```
Wallet 1───* Transaction *───1 LedgerEntry
   │                              │
   └──────────*  Transfer  *──────┘
                    │
                    ▼
              OutboxEvent (staged domain events)
```

- **Wallet**: `userId`, `ownerName`, `currency`, `balance`, `version`.
- **Transaction**: `walletId`, `type` (`DEPOSIT`/`WITHDRAWAL`/`TRANSFER_IN`/
  `TRANSFER_OUT`), `amount`, `status`, `balanceAfter`, optional `reference`,
  `transferId`, `counterpartyWalletId`.
- **LedgerEntry**: `transactionId`, `walletId`, `direction` (`DEBIT`/
  `CREDIT`), `amount`, `balanceAfter`.
- **Transfer**: `fromWalletId`, `toWalletId`, `amount`, `status` (`PENDING`/
  `COMPLETED`/`FAILED`), optional `idempotencyKey`, `failureReason`.
- **OutboxEvent**: `routingKey`, `payload`, `status` (`PENDING`/`PUBLISHED`).
- **User**: `email`, `passwordHash`, `fullName`.

## Deployment

`docker-compose.yml` runs MongoDB (as a single-node replica set, required for
multi-document transactions), Redis, RabbitMQ, and the API image built from
the repository `Dockerfile` (multi-stage, `node:20-alpine`, non-root user).
