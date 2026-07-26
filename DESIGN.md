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

## 4. How did you ensure data consistency?

Specifically: across MongoDB writes, the cache, and the message queue. Where
does the system currently allow the ledger, the cached balance, or a
downstream consumer to disagree with the source of truth, and what (if
anything) did you do about each?

The idempotency fix prevents a retry from creating a second transfer, sender
debit, ledger entry, or event. It does not address the separate issue of
RabbitMQ publication occurring inside the MongoDB transaction.

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

## 6. Remaining technical debt

What's still broken or fragile after your changes? Be specific - this is
more useful to us than a clean-sounding summary.

- Add an automated OpenAPI assertion ensuring protected operations retain the
  `bearer` requirement while public operations do not.

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
