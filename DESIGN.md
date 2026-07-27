# Design Notes

## 1. What issues did you find?

I found four main classes of problems.

### Financial correctness

- Withdrawals and transfers used read/check/save sequences, so concurrent
  requests could approve against the same balance and make a wallet negative.
- Deposit, withdrawal, and transfer retries could repeat financial side effects.
  The supplied reference/idempotency fields were stored but not enforced.
- Deposit and withdrawal balance changes, transaction records, and ledger
  entries were separate writes. A later failure could leave them inconsistent.
- Transfer settlement updated the receiver, transaction, ledger, and transfer
  status independently. Duplicate delivery could credit the receiver twice.

I confirmed these through code reading, the visible tests, and real concurrent
integration requests against MongoDB.

### Database/message consistency

- Transfer events were published inside a MongoDB transaction callback.
  RabbitMQ cannot join that transaction, so an event could survive a rollback.
- The outbox relay can publish the same event more than once if it crashes after
  broker confirmation but before marking the record published. The consumer was
  not safe under that delivery model.
- The stale-transfer worker only logged old `PENDING` transfers. It did not
  recover them, so a debited sender could have funds trapped indefinitely.
- The seed script still modelled double-credit delivery after settlement had
  been made idempotent. It exposed this mismatch by failing on a unique index.

### Runtime and operability

- Redis balances were not invalidated after writes, so customers could see old
  balances until TTL expiry.
- The wallet snapshot worker added listeners every ten seconds and never removed
  them. `setMaxListeners(0)` hid the warning rather than fixing the leak.
- Correlation IDs stopped at the HTTP response. Request, relay, RabbitMQ, and
  consumer logs could not be tied to the same transfer.

### API and query behaviour

- Swagger registered bearer authentication but did not mark protected operations
  as requiring it, so "Try it out" omitted the token.
- The dashboard loaded the complete transaction history, queried ledger entries
  once per transaction, and only then sliced to ten results. Query count and
  memory use grew with wallet history.

## 2. What did you prioritize, and why?

I prioritized anything that could create, lose, or trap money. That meant
negative balances, retry idempotency, transaction/ledger atomicity, the
MongoDB/RabbitMQ commit gap, duplicate settlement, and stale transfers came
before performance or observability.

The key design choice was to make MongoDB the authority for concurrency rather
than relying on checks in application memory. Conditional updates enforce
available funds; unique partial indexes enforce idempotency; and MongoDB
transactions keep each financial state transition together.

I used the existing outbox rather than adding a new messaging abstraction.
Transfer initiation now commits the sender debit and event intent together, and
the consumer is safe when the relay publishes twice. For stale transfers, I
chose bounded replay over automatic refunds. A settlement may still be in
flight, so refunding could put money back with the sender and later credit the
receiver as well.

Once the financial paths were stable, I addressed the concrete operational
reports: stale cache values, listener growth, uncorrelated logs, and the
dashboard N+1 query. I also fixed Swagger early because it made manual review of
the protected API unnecessarily difficult.

## 3. How did you handle concurrency?

Withdrawals and sender-side transfers now use conditional atomic updates with
`balance >= amount` and a negative `$inc`. Under any interleaving, MongoDB only
allows operations covered by the current committed balance. Integration tests
run ten simultaneous withdrawals and ten simultaneous transfers, then reconcile
the final balance with successful responses.

Transfer, deposit, and withdrawal idempotency is backed by unique partial
indexes rather than a service-level lookup alone. A sequential retry returns the
existing result. If two first attempts race, one insert wins; the losing MongoDB
transaction rolls back its tentative balance change and returns the committed
record. Reusing a deposit or withdrawal reference with a different amount
returns `409 Conflict`.

Settlement atomically changes a matching transfer from `PENDING` to `COMPLETED`
inside the same transaction as the receiver credit, inbound transaction, and
ledger entry. A concurrent or repeated delivery sees `COMPLETED` and becomes a
no-op. The real integration test delivers the same event twice and observes one
credit.

Stale-transfer recovery also claims work transactionally. Concurrent sweepers
enqueue one recovery attempt, space later attempts with `nextRecoveryAt`, and
stop after a configured limit.

## 4. How did you ensure data consistency?

MongoDB remains the financial source of truth. Deposit, withdrawal, and transfer
initiation each commit the balance mutation, transaction record, ledger entry,
and outbox intent in one MongoDB transaction. Settlement does the equivalent for
the receiving side. Fault-injection tests verify rollback when ledger or outbox
writes fail.

RabbitMQ delivery is treated as at least once. The outbox closes the pre-commit
publication gap, while the consumer makes repeated publication safe. Transient
consumer failures are negatively acknowledged and requeued. Malformed or
mismatched events are logged and acknowledged so they do not poison-loop; a DLQ
is still needed for durable investigation.

Redis is a disposable read-through cache. Successful balance mutations
invalidate the affected key only after commit. Invalidation failures are logged
instead of changing a successful financial response, because MongoDB may already
contain the committed result. A narrow cache-aside race remains and is documented
below.

Correlation IDs are stored in the transactional outbox payload, restored by the
relay, copied into AMQP properties, and restored again by the consumer. This
keeps one identifier across an HTTP request and delayed asynchronous settlement.

The verification suite covers concurrency, duplicate requests and events,
transaction rollback, cache freshness, stale-transfer recovery, RabbitMQ,
dashboard aggregation, and HTTP authentication. The final run passed 43 unit,
19 integration, and 2 e2e tests. A clean seed produced 20 wallets, 516
transactions, 516 ledger entries, and 10 transfers.

## 5. Trade-offs

- Idempotency keys remain optional for backward compatibility. Requests without
  them cannot be made safe against client retries. New unique indexes require a
  controlled rollout, including reconciliation of historical duplicates.
- MongoDB transactions and conditional updates add latency and may increase
  contention on high-traffic wallets. I accepted that cost to protect balances
  and audit records.
- Settlement is asynchronous. The relay can still publish twice at its
  confirmation/mark-published boundary, so consumer idempotency is required.
- Recovery leaves exhausted transfers `PENDING` and flags them for manual review.
  This is less automatic than refunding, but it avoids creating money when an
  event is merely delayed.
- Cache invalidation adds a Redis round trip. Best-effort handling can leave a
  stale value until TTL expiry, and a reader can still repopulate an old value in
  a narrow race around commit/invalidation.
- The dashboard now performs a constant number of queries, but its summary
  aggregation still scans one wallet's indexed transaction history. Very large
  histories may eventually need materialized summaries.
- The snapshot worker now uses one payload-based internal event instead of a
  dynamically named event per wallet. No repository consumer used the old names,
  but an undocumented in-process consumer would need to migrate.
- Persisting correlation IDs slightly enlarges outbox and AMQP payloads. They are
  diagnostic identifiers only, not authentication or idempotency inputs.
- MongoDB transactions require a replica set, including in local development;
  the Docker Compose configuration documents and provides this.

## 6. Remaining technical debt

- Add a transfer DLQ with bounded retry/backoff and durable poison-message
  inspection.
- Add an operator workflow and alert for transfers that exhaust recovery.
- Close the remaining cache-aside race with version-aware cache writes or a
  stricter balance read path.
- Add metrics for outbox lag, settlement latency, retries, and recovery
  exhaustion.
- Add an automated OpenAPI assertion so protected operations retain the bearer
  requirement.
- Rehearse the new index creation against production-shaped data before rollout.

## 7. What would you improve with another day?

I would start with the DLQ and bounded retry policy because the current consumer
either requeues indefinitely or acknowledges malformed input after logging. I
would retain correlation and failure metadata so an operator could inspect and
replay a message safely.

Next, I would build the operator path for exhausted transfers: alerting, a
protected inspection endpoint, and an audited replay/reconcile action. I would
not add automatic refunds without a stronger guarantee that no settlement is in
flight.

With the remaining time, I would add operational metrics and close the Redis
race for clients that require strict read-after-write balances.

## 8. Assumptions

- MongoDB is the source of truth and runs as a replica set.
- RabbitMQ delivery is at least once; duplicate publication is normal.
- Transfer settlement may be delayed, but a committed sender debit must
  eventually settle or become visible to an operator.
- Client-provided idempotency keys identify one logical operation. Reusing a key
  with a different deposit or withdrawal amount is an error.
- Redis failure must not undo or misreport a committed MongoDB operation.
- Login and health are public; wallet and transaction endpoints are protected.
- Swagger users provide the raw JWT and Swagger adds the `Bearer` prefix.
