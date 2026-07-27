# Design Notes

Fill this in as part of your submission. We'd rather read a clear, honest
account of a partial fix than a vague description of a complete one. Bullet
points are fine; prose is fine. Aim for signal over length.

## 1. What issues did you find?

List everything you identified, whether or not you fixed it. Include how you
found each one (code reading, a failing test, reproducing it under load,
etc.).

- **Swagger did not send JWT credentials to protected endpoints.** Code tracing
  showed that `DocumentBuilder.addBearerAuth()` registered a scheme, but the
  wallet and transaction operations had no matching OpenAPI security
  requirement. Swagger stored the token but did not attach an
  `Authorization: Bearer <token>` header to "Try it out" requests.
- **Transfer retries created duplicate financial side effects.** A visible unit
  test reproduced two transfer documents for two calls using the same
  `idempotencyKey`. The field was stored but never queried and had no unique
  database index, allowing repeated sender debits, ledger entries, and events.
- **Concurrent withdrawals could make a wallet negative.** Code inspection
  found a read/check/mutate/save sequence, and the visible concurrency test
  reproduced the race under parallel requests. Multiple requests could approve
  against the same stale balance before any save completed.
- **Transfer events could be published before MongoDB committed.** The transfer
  service called RabbitMQ inside the MongoDB transaction callback. RabbitMQ
  cannot participate in that transaction, so an event could survive even if a
  later database write or commit rolled back the sender debit.
- **Duplicate transfer events credited receivers repeatedly.** The consumer
  performed an unconditional read/add/save and wrote the credit transaction,
  ledger entry, and transfer status independently. It also acknowledged every
  exception, permanently discarding transient failures.
- **Balance reads returned stale Redis values after writes.** `getWallet()` used
  a read-through balance cache, but deposit, withdrawal, sender debit, and
  receiver credit paths never invalidated it. A cached pre-transaction balance
  remained visible until its TTL expired.
- **Deposits and withdrawals could partially persist.** Their wallet balance,
  transaction history, and ledger writes were independent. A later failure
  could leave balances without matching auditable records.
- **Concurrent transfers could overspend a sender.** Transfer initiation read
  and approved the sender balance before starting its transaction, then saved a
  stale in-memory wallet document. Parallel transfers could all approve against
  the same original balance.
- **The seed data contradicted the repaired delivery invariant.** The seed
  deliberately created two `TRANSFER_IN` transactions and credited a receiver
  twice for one transfer. After settlement became idempotent, this fixture both
  misrepresented expected behavior and failed against the unique
  `(transferId, type)` transaction index with MongoDB error `11000`.

## 2. What did you prioritize, and why?

Of everything above, what did you actually spend your time on? What's your
reasoning - severity, blast radius, how common the trigger condition is,
how cheap the fix was, something else?

I first fixed Swagger authentication because it blocked manual exploration and
review of every protected endpoint. I named the bearer scheme `bearer` and
applied `@ApiBearerAuth('bearer')` only to the protected wallet and transaction
controllers. Login and health remain visibly public. TypeScript compilation,
ESLint, and whitespace validation passed.

I next fixed transfer request idempotency because a duplicate sender debit is a
direct financial-loss risk. Normal retries now return the existing transfer. A
unique partial MongoDB index and duplicate-key recovery protect concurrent
retries.

I then fixed concurrent withdrawal overspending because it violates the core
wallet invariant. The balance check and decrement are now one conditional
MongoDB update, making the fix small and directly enforceable by the source of
truth.

I then moved transfer publication to the existing transactional outbox because
the original ordering could create money: a receiver might be credited from an
event whose sender debit never committed. This reuses existing infrastructure
and removes RabbitMQ from the request path.

I next made settlement transactional and idempotent because outbox delivery is
at least once by design. Without this guarantee, a normal relay retry could
create money by crediting the receiver twice.

I next fixed cache freshness because customers could observe a balance that
disagreed with MongoDB immediately after a successful operation. The change is
bounded to invalidating affected wallet keys after balance mutations complete.

I then made deposits and withdrawals transactional because balance/history
disagreement breaks auditability and reconciliation. Both paths now include the
balance mutation, transaction record, ledger entry, and outbox intent in one
MongoDB transaction.

I next fixed concurrent sender debits because transfers still had the same
overspending class previously removed from withdrawals. The database now makes
the funds-availability decision inside the transfer transaction.

I then aligned the seed data with the repaired at-least-once delivery behavior.
The replay fixture now represents two deliveries settling exactly once: one
receiver credit, one inbound transaction, and one ledger entry. This keeps local
demo data useful without encoding an incident that the current design prevents.

## 3. How did you handle concurrency?

Where in the system can two requests race each other? What did you change,
and what guarantee does your fix actually provide (e.g. "no negative
balances under any interleaving" vs. "much less likely under realistic
load")? How did you verify it - a test, a manual load script, reasoning
about the code?

The service lookup handles sequential transfer retries, while the database
unique index is the concurrency authority. If two requests race, only one can
insert the key; the loser handles MongoDB error `11000` and returns the winning
transfer after its transaction aborts. Unit tests cover both paths, and a real
MongoDB integration test verifies one transfer and one sender debit.

Withdrawals now use `findOneAndUpdate` with `balance >= amount` and an atomic
negative `$inc`. MongoDB permits only the withdrawals covered by the current
balance, regardless of request interleaving. A real integration test runs ten
simultaneous withdrawals and verifies that the final balance is non-negative
and exactly reconciles with the successful responses.

Settlement atomically claims only a matching `PENDING` transfer inside the same
MongoDB transaction as the receiver balance increment, credit transaction, and
ledger entry. Concurrent or repeated deliveries observe `COMPLETED` and become
no-ops. A real MongoDB test delivers the same event twice and verifies one
credit, one transaction, and one ledger entry.

Transfer initiation now conditionally decrements the sender with
`balance >= amount` and `$inc` inside the MongoDB transaction. Only transfers
covered by the current balance can commit under any request interleaving. Ten
simultaneous integration requests verify that the sender never becomes
negative, its balance reconciles with successful requests, and the receiver
eventually receives exactly the committed total.

## 4. How did you ensure data consistency?

Specifically: across MongoDB writes, the cache, and the message queue. Where
does the system currently allow the ledger, the cached balance, or a
downstream consumer to disagree with the source of truth, and what (if
anything) did you do about each?

The idempotency fix prevents a retry from creating a second transfer, sender
debit, ledger entry, or event. Transfer initiation now writes its
`transfer.initiated` outbox record using the same MongoDB session as the
transfer, debit transaction, and ledger entry. These records commit or roll
back together. The relay publishes only durable outbox records after commit.
An integration test verifies both the outbox record and eventual receiver
credit.

Transient consumer failures are now negatively acknowledged and requeued.
Malformed JSON or invalid event identities are acknowledged after logging so a
poison message cannot loop forever. Event fields must match the stored pending
transfer before any credit is applied.

MongoDB remains authoritative and Redis now acts only as a disposable
read-through cache. Deposits and withdrawals invalidate after their successful
write sequence; sender transfer balances invalidate after initiation commits;
receiver balances invalidate after settlement commits. Redis failures are
logged rather than returned as operation failures because MongoDB may already
contain the committed financial change.

Deposit and withdrawal writes now share a MongoDB session and transaction. They
either commit the wallet balance, transaction history, ledger entry, and domain
event together or roll all of them back. Cache invalidation happens only after
commit. Fault-injection integration tests prove rollback when a deposit outbox
write or withdrawal ledger write fails.

The seed generator now preserves the same transfer-delivery invariant as the
runtime consumer. A full clean seed completed with 20 wallets, 516 transactions,
516 ledger entries, and 10 transfers, and a subsequent API smoke test verified
an asynchronous transfer changed balances from `200/0` to `125/75` exactly once.

## 5. Trade-offs

What did your fixes cost - complexity, latency, throughput, code
readability, backward compatibility? Where did you choose a simpler, more
conservative fix over a more complete one, and why?

The Swagger change affects documentation metadata only; it does not alter the
runtime JWT guard or HTTP API. Controller-level annotations mean future
protected controllers must add the same decorator. A global OpenAPI security
requirement would reduce that maintenance cost, but would present login and
health as protected unless each public operation was explicitly overridden.

Transfer keys remain optional for backward compatibility, so requests without
a key are not idempotent. The unique index adds a small write and storage cost.
A reused key currently returns the original transfer; stricter request
fingerprint validation could reject reuse with different wallets or amounts.

The atomic withdrawal update also increments the existing wallet `version`
field. A failed conditional update needs a second read to distinguish a missing
wallet (`404`) from insufficient funds (`400`), adding one query only on failure.
MongoDB transactions add latency and require the documented replica-set
deployment. New wallet deposit/withdrawal events also add outbox and broker
volume, but preserve a durable post-commit event boundary.

Conditional sender updates can contend on a high-traffic wallet, causing
MongoDB transaction retries and lower throughput. That cost is preferable to
overspending. Destination existence requires an additional transactional query
because the stale pre-transaction wallet reads were removed.

Outbox delivery is asynchronous, so settlement gains a small delay and depends
on the relay. The relay may publish twice if it crashes after RabbitMQ confirms
publication but before it marks the outbox record as published. This is safe
only when the consumer is idempotent; that consumer fix remains separate.

Settlement now uses a MongoDB transaction, increasing write latency but making
the wallet, transaction, ledger, and transfer status an atomic unit. Malformed
events are dropped because the project has no dead-letter queue; production
should retain them in a DLQ for investigation.

Invalidation adds a Redis round trip to successful writes. Best-effort handling
avoids misleading clients with an error after a committed MongoDB write, but a
failed invalidation can leave stale data until TTL expiry. There is also a narrow
cache-aside race where a reader can fetch an old MongoDB value before a commit,
then populate Redis after invalidation; versioned cache values would close it.

## 6. Remaining technical debt

What's still broken or fragile after your changes? Be specific - this is
more useful to us than a clean-sounding summary.

- Add an automated OpenAPI assertion ensuring protected operations retain the
  `bearer` requirement while public operations do not.
- Add a dead-letter queue and bounded retry/backoff policy for malformed or
  persistently failing transfer events.
- Add version-aware cache writes or bypass cached balance reads where strict
  read-after-write consistency is required.

## 7. What would you improve with another day?

If we gave you one more full day on this, where would you spend it and why?

## 8. Assumptions

Anything you assumed about requirements, scale, traffic patterns, or
acceptable behavior that isn't spelled out in the README - state it here so
we can evaluate your reasoning rather than guessing at it.

- Swagger users paste the raw JWT into the Authorize dialog; Swagger adds the
  `Bearer` prefix.
- Wallet and transaction controllers are protected. Login and health are
  intentionally public.
