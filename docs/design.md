# T-103: Crypto Exchange Wallet & Double-Entry Ledger — Design Document

**Version:** v1.4 (Production Money Hardened) | **Stack:** NestJS 12, TypeScript, PostgreSQL 18, Drizzle ORM (`pg`), RabbitMQ (bonus), No Redis  
*Empirical behaviors captured from `hamtapay/t103-simulator:1.0` (`default` & `hostile`) are logged with evidence in [`docs/provider-notes.md`](./provider-notes.md).*

> Each section below opens with the **simple intuition** behind the design choice before detailing the exact tables, locks, triggers, and state transitions.

---

## 1. Service & Module Boundaries

**Simple Intuition:**
Keep everything that touches money—wallets, ledger entries, daily limits, idempotency, and outbox events—inside one modular NestJS app backed by a single PostgreSQL database. Splitting those across microservices or adding Redis locks only creates windows where one piece updates and another fails. Keeping clean module boundaries in code gives us structure, while one ACID database keeps money exact and lets us scale stateless replicas safely.

**Technical Implementation:**
**NestJS Modular Monolith** over Microservices: keeps Wallet, Ledger, Limits, and Outbox inside single-DB ACID transactions—eliminating distributed `2PC`/Saga drift—while scaling horizontally via stateless replicas (like Shopify's BFCM Modular Monolith), with PostgreSQL as sole source of truth, inbound/outbound `X-Request-Id` correlation propagation, and a global `ExceptionFilter` enforcing `{"code", "message"}` on all errors:

- **`WalletModule` & `LedgerModule`** *(Intuition: create user sub-accounts lazily and keep balances derived strictly from balanced ledger postings + outbox events in one TX)*:
  - Lazy user sub-accounts (`AVAILABLE`, `LOCKED`, `RECEIVABLE`), DB-materialized double-entry engine (`LedgerService.postTransaction()` atomically writes `outbox_events` in the same TX whenever any `USER` balance changes).
  - `GET /wallets/:userId` (`200` with `"0"` balances for unseen users, never `404`), and keyset-paginated `GET /wallets/:userId/ledger` (defaults to `ALL`; `?accountType=AVAILABLE` selects the available sub-account; `cursor` bounded strictly to signed 64-bit `BIGINT`).
- **`IdempotencyModule`** *(Intuition: claim the idempotency key first before doing real work, scope it per user/route so users can't collide, and use DB-clock leases for external calls)*:
  - Customer writes scope `PK(scope, key)` by route and user ID. Guards compare canonical payload hashes before DTO validation when a valid user scope is available.
  - Database-only writes claim the key in statement one and run business mutations under a savepoint. The outer transaction commits the receipt for successful responses and deterministic domain `400`/`422` errors.
  - External PSP deposit creation uses a DB-clock lease and `lease_version` fencing. Retention deletes expiring rows in primary-key batches with `SKIP LOCKED`.
- **`DepositModule`** *(Intuition: save the PSP token before returning, treat callbacks as wake-up hints only, always ask the PSP directly before crediting, and keep polling a bit past expiry in case payment lands late)*:
  - Initiates PSP payments (`POST /deposits`, failing `_finalizeAwaitingDeposit` with `409` on `0`-row `INITIATED` updates if `DepositPoller` expired the row).
  - Treats unsigned callbacks as wake-up hints only (safely backfilling missing `psp_token` via `GET /psp/payments/{token}` `orderId` verification when needed), fences unsettled updates with `(status, version)` CAS.
  - Checks `orderId` (deduplicated discrepancy logging + poll halt) and non-10x IRR remainders (`hasIrrRemainder`), preserves a post-expiry `DEPOSIT_EXPIRY_GRACE_MS` poll window, sizes worker leases above `PROVIDER_HTTP_TIMEOUT_MS` (`computeSafeLeaseMs`), and runs `DepositPoller` for dropped callbacks, crashes, and expiry recovery.
- **`WithdrawalModule`** *(Intuition: lock funds and reserve daily quota in Postgres first, dispatch asynchronously with leases so two workers never send twice, never auto-fail on silence/timeouts, and halt to `MANUAL_REVIEW` whenever anything looks inconsistent)*:
  - Enforces pre-validation user-scoped idempotency, DTO bounds (`MAX_AMOUNT_MINOR = 10^15`), runtime `system_controls` pause flags (`503 SERVICE_PAUSED`), destination/minimum/restrictions/limits, holds funds (`AVAILABLE → LOCKED`) via `WithdrawalLedgerService`.
  - Supports idempotent pre-dispatch cancel (`POST /withdrawals/:id/cancel`, requiring `Idempotency-Key` and the owner ID, `409` once `DISPATCHING`+).
  - Dispatches payouts via `SKIP LOCKED` + `version` fencing + timeout-scaled leases + jittered `503` retry backoff, escalates SLA-breaching `DISPATCHING` and `PROCESSING` rows to `MANUAL_REVIEW` (while safely CAS re-dispatching unaccepted `provider_ref_id IS NULL` `MANUAL_REVIEW` rows on `404`).
  - Verifies raw-body HMAC-SHA256 webhooks, **halts** settlement/release into `MANUAL_REVIEW` (with `next_poll_at = NULL`, funds `LOCKED`) on `PAYOUT_PAYLOAD_MISMATCH`, delegates all transitions to pure `decideWithdrawalTransition`, offsets `USER:RECEIVABLE` first on `WD_RETURN`, shields `terminal_return`/`CANCELLED_BY_USER` rows from false `WD_LATE_SUCCESS` (verifying late webhook `SUCCEEDED` via `GET /payout/transfers/{id}` and restoring daily quota), and exposes `POST /internal/withdrawals/:id/resolve` for Ops closure.
- **`AdjustmentModule` & Health** *(Intuition: lock down internal ops endpoints, automatically pause withdrawals if any balance drift is ever detected, serialize replica migrations, and restrict DB runtime permissions)*:
  - `POST /internal/adjustments`, `POST /internal/receivables/settle`, `POST /internal/withdrawals/:id/resolve`, `POST /internal/controls/withdrawals-pause`, `GET /internal/metrics`, `GET /internal/metrics/prometheus`, and `POST /reconciliation/run` are guarded by `InternalOpsGuard` (requiring `INTERNAL_API_KEY` except with explicit local opt-in).
  - `DriftAuditWorker` refreshes the single-flight `balanceDriftAccounts` gauge and automatically trips `withdrawals-pause` across `['IRT', 'USDT']` if drift is ever detected.
  - Startup `runMigrations()` serializes across replicas via `pg_advisory_lock(840103)` and restricts `t103_app` `DELETE` grants exclusively to retention tables (`idempotency_keys`, `outbox_events`, `processed_events`).
- **`ProvidersModule`** *(Intuition: isolate external HTTP quirks and Toman/Rial conversions in one adapter layer)*:
  - Isolated HTTP adapters (`PspClient`, `PayoutClient`) propagating `X-Request-Id`, handling timeouts, raw-body lowercase-hex HMAC verification, `IRT × 10 ↔ IRR` conversion on **both** PSP and Payout, and Persian/dirty-CSV normalization.
- **Bonus Modules** *(Intuition: atomic P2P transfers in Postgres, dirty-CSV reconciliation against local deposits, and reliable RabbitMQ publishing via the DB outbox)*:
  - `TransferModule` (`POST /transfers`, rejects `fromUserId === toUserId` with `400`).
  - `ReconciliationModule` (`POST /reconciliation/run` CSV diff and durable exact-match settlement dates using `RECONCILIATION_TZ`, `rowNumber`-aware CSV dedup, explicit `adjacentDayMatches` `MATCHED_ADJACENT_DAY` reporting).
  - `OutboxModule` (RabbitMQ `ConfirmChannel` with a five-second deadline + `lease_until` fencing + `OutboxWorker` consumer auto-reconnect on every tick + `processed_events` dedup).

**Multi-Instance Coordination** *(Intuition: never keep locks in Node memory so any pod can crash or scale without corrupting work)*:
Stateless instances share no in-memory locks; workers (`DepositPoller`, `WithdrawalDispatcher`, `WithdrawalPoller`, `OutboxRelay`, `RetentionWorker`) claim work with `SELECT ... FOR UPDATE SKIP LOCKED`, `lease_until`, and monotonic `version`/`lease_version` fencing tokens.

---

## 2. Data Model (Tables, Keys, Indexes & Constraints)

**Simple Intuition:**
Separate the **accounting truth** from the **action workflows**. Every money movement writes an immutable transaction header (`ledger_transactions`) and balanced debit/credit line items (`ledger_items`), while each product action (`deposits`, `withdrawals`, `transfers`, `adjustments`) lives in its own table tracking status, retries, and provider references. Never trust application code to update `accounts.balance` directly—let PostgreSQL triggers update `USER` balances only inside balanced ledger inserts, enforce `balance >= 0` with `CHECK` constraints, and keep `SYSTEM` account balances `NULL` so concurrent users never block each other on a global clearing row.

All entity PKs use time-ordered **`UUIDv7`** (`uuid`). Monetary columns use **`NUMERIC(38,0)` minor units** (`1 IRT = 1 Toman`, `1 USDT = 1,000,000 micro-USDT`), mapping 1:1 to TypeScript `bigint` with zero floats.

| Table | Key Columns & Types | Constraints & Critical Indexes |
| --- | --- | --- |
| `accounts` | `id UUIDv7 PK`, `owner_type` (`account_owner_type` enum), `owner_id`, `currency` (`currency` enum), `account_type` (`account_type` enum), `normal_side` (`ledger_direction` enum), `balance NUMERIC(38,0)` (`NULL` on `SYSTEM`) | `UNIQUE(owner_type, owner_id, currency, account_type)`; `accounts_type_normal_side_chk`; `CHECK ((owner_type = 'SYSTEM' AND balance IS NULL) OR (owner_type = 'USER' AND balance >= 0))`; `BEFORE UPDATE OF balance` forbids direct SQL edits; `trg_accounts_immutable_meta` rejects non-zero `USER` inserts and immutable column/`normal_side` changes |
| `ledger_transactions` | `id UUIDv7 PK`, `type` (`ledger_tx_type` enum), `reference_type` (`ledger_ref_type` enum), `reference_id`, `description`, `metadata JSONB`, `created_at` | `UNIQUE(reference_type, reference_id, type)`; append-only trigger (`UPDATE`/`DELETE`/`TRUNCATE`) |
| `ledger_items` | `id BIGINT GENERATED ALWAYS AS IDENTITY PK`, `transaction_id FK`, `account_id FK`, `user_id`, `account_type` (`account_type` enum), `currency` (`currency` enum), `direction` (`ledger_direction` enum), `amount NUMERIC(38,0)`, `balance_after` (`NULL` on `SYSTEM`) | Append-only trigger (`UPDATE`/`DELETE`/`TRUNCATE`); `BEFORE INSERT` trigger verifies parent TX belongs to `pg_current_xact_id()`, projects `USER` `accounts.balance` via `normal_side`, and sets `balance_after`; `CHECK (amount > 0)`; `ledger_items_tx_idx (transaction_id)` + partial cursor index `(user_id, id DESC) WHERE user_id IS NOT NULL` |
| `user_daily_limits` | `user_id TEXT`, `limit_date DATE`, `used_irt_amount NUMERIC(38,0)` | `PK(user_id, limit_date)`, `CHECK (used_irt_amount >= 0)` |
| `user_restrictions` | `user_id TEXT PK`, `outbound_frozen BOOLEAN`, `freeze_reason TEXT`, `updated_at` | Checked inside **both** `/withdrawals` and `/transfers` before balance hold; cleared when receivable total hits `0` |
| `idempotency_keys` | `scope TEXT`, `key TEXT`, `request_hash`, `status`, `response_status`, `response_body JSONB`, `locked_until`, `lease_version BIGINT`, `expires_at` | `PK(scope, key)`; index on `expires_at`; purged in batches by `RetentionWorker` |
| `deposits` | `id UUIDv7 PK`, `user_id`, `requested_amount`, `verified_amount`, `amount_mismatch BOOLEAN`, `order_id UNIQUE`, `psp_token UNIQUE`, `psp_ref_id`, `status`, `expires_at`, `next_poll_at`, `verified_at`, `version BIGINT` | Covering partial index `(next_poll_at) INCLUDE (id) WHERE status <> 'SUCCEEDED' AND next_poll_at IS NOT NULL`; partial index `(verified_at) WHERE status = 'SUCCEEDED'`; partial unique `(psp_ref_id) WHERE psp_ref_id IS NOT NULL` |
| `withdrawals` | `id UUIDv7 PK`, `user_id`, `currency`, `amount`, `fee`, `fx_rate_irt`, `irt_equivalent`, `limit_date`, `quota_released BOOLEAN`, `destination`, `provider_request_id VARCHAR(64) UNIQUE`, `provider_ref_id`, `status`, `failure_reason`, `terminal_return BOOLEAN`, `late_success_conflict BOOLEAN`, `version BIGINT`, `lease_until`, `next_poll_at` | Covering partial index `(created_at) INCLUDE (status, lease_until) WHERE status IN ('PENDING_DISPATCH','DISPATCHING')`; partial index `(next_poll_at) WHERE status IN ('PROCESSING','MANUAL_REVIEW','FAILED') AND next_poll_at IS NOT NULL` |
| `adjustments` | `id UUIDv7 PK`, `user_id`, `currency`, `amount`, `reason`, `operator_id`, `created_at` | Audit record referenced by `OPS_ADJ` ledger transaction |
| `financial_discrepancies` | `id UUIDv7 PK`, `reference_type` (`DEPOSIT\|WITHDRAWAL`), `reference_id UUID`, `user_id`, `discrepancy_type`, `amount`, `currency`, `provider_payload JSONB`, `status` | `UNIQUE(reference_type, reference_id, discrepancy_type)`; combined partial `(user_id, currency) WHERE status = 'OPEN'` for Ops metrics & receivable resolution (`AMOUNT_MISMATCH`, `ORDER_ID_MISMATCH`, `PAYOUT_PAYLOAD_MISMATCH`, `LATE_SUCCESS_CONFLICT`) |
| `system_controls` | `key TEXT PK`, `value JSONB`, `updated_at` | Runtime operational control flags (e.g., `withdrawals_paused_currencies`) |
| `transfers` / `outbox_events` / `processed_events` *(bonus)* | `transfers(id, from_user_id, to_user_id, currency, amount)`; `outbox_events(id, event_type, payload, status, lease_until, next_retry_at)`; `processed_events(event_id, consumer_name)` | `outbox` partial `(next_retry_at) WHERE status='PENDING'` (UUIDv7 PK bounds retention); `PK(event_id, consumer_name)` (UUIDv7 `event_id` bounds retention) |

### Double-Entry Posting Matrix (`CREDIT = +` on `CREDIT`-normal `AVAILABLE`/`LOCKED`/`FEE_REVENUE`; `DEBIT = +` on `DEBIT`-normal `RECEIVABLE`/clearing)

**Simple Intuition:**
User balances (`AVAILABLE` and `LOCKED`) are money the exchange owes the user (liabilities, so credits increase them and debits decrease them). If a user ends up owing the exchange money (from a late-success withdrawal), that debt goes into `RECEIVABLE` (an asset, so debits increase it and credits pay it down). Every posting balances debits and credits to zero in the same currency.

| Event (`type`) | Debit Account(s) | Credit Account(s) |
| --- | --- | --- |
| Deposit Succeeded (`DEPOSIT`) | `SYSTEM:PSP_CLEARING` (`verified`, `+`) | `USER:{id}:IRT:AVAILABLE` (`verified`, `+`) |
| Ops Credit (`OPS_ADJ`) | `SYSTEM:OPS_ADJUSTMENT` (`+`) | `USER:{id}:{ccy}:AVAILABLE` (`+`) |
| Withdrawal Hold (`WD_HOLD`) | `USER:{id}:{ccy}:AVAILABLE` (`amount + fee`, `-`) | `USER:{id}:{ccy}:LOCKED` (`amount + fee`, `+`) |
| Withdrawal Succeeded (`WD_SETTLE`) | `USER:{id}:{ccy}:LOCKED` (`amount + fee`, `-`) | `SYSTEM:PAYOUT_CLEARING` (`amount`), `SYSTEM:FEE_REVENUE` (`fee` if > 0) |
| Withdrawal Failed / Cancelled (`WD_RELEASE`) | `USER:{id}:{ccy}:LOCKED` (`amount + fee`, `-`) | `USER:{id}:{ccy}:AVAILABLE` (`amount + fee`, `+`) |
| Bank Return (`WD_RETURN`) | `SYSTEM:PAYOUT_CLEARING` (`amount`), `SYSTEM:FEE_REVENUE` (`fee` if > 0) | `USER:{id}:{ccy}:RECEIVABLE` (`min(receivable, totalRefund)`, `-` debt), remainder to `USER:{id}:{ccy}:AVAILABLE` (`+`) |
| Late-Success Conflict *(Ambiguity #1)* (`WD_LATE_SUCCESS`) | `USER:AVAILABLE` (`clawback`, `-`), `USER:RECEIVABLE` (`shortfall`, `+ >= 0`) | `SYSTEM:PAYOUT_CLEARING` (`amount`), `SYSTEM:FEE_REVENUE` (`fee` if > 0) |
| Receivable Settlement (`RECEIVABLE_SETTLE`) | `USER:{id}:{ccy}:AVAILABLE` (`-`) | `USER:{id}:{ccy}:RECEIVABLE` (`-` debt, clears automatic freeze when both currencies reach zero) |
| Internal Transfer *(bonus)* (`TRANSFER`) | `USER:{from}:{ccy}:AVAILABLE` (`-`) | `USER:{to}:{ccy}:AVAILABLE` (`+`) |

**Canonical Lock Order:**
- **Simple Intuition:** Deadlocks only happen when two transactions lock the same rows in opposite orders. Prevent that by creating missing rows up front and always acquiring exclusive `FOR UPDATE` locks in one fixed global order (`idempotency_keys` → `user_daily_limits` → `user_restrictions` → `USER` `accounts` by `id ASC`).
- **Technical Details:** Lazy `INSERT ... ON CONFLICT DO NOTHING` upserts run deterministically sorted by `(owner_type, owner_id, currency, account_type) ASC` (or autocommit pre-ensure) *before* acquiring `SELECT ... FOR UPDATE` locks in strict order: `idempotency_keys (scope, key)` → `user_daily_limits (user_id, limit_date)` → `user_restrictions (user_id)` → **`USER` `accounts` sorted by `id ASC`** (deadlock-free even on brand-new users). `SYSTEM` accounts keep `balance IS NULL` and are never locked or updated.

---

## 3. State Machines (Deposits & Withdrawals)

### Deposit State Machine
`INITIATED` → `AWAITING_PAYMENT` → `VERIFYING` → `SUCCEEDED` | `FAILED` *(with post-expiry grace recovery)*

**Simple Intuition:**
Never trust an unsigned deposit callback on its own, and never call `/psp/verify` blindly before checking `GET /psp/payments/{token}`—use the callback as a wake-up signal, verify directly with the PSP, only credit the exact verified amount once, hold/flag any mismatches or overpayments instead of guessing, and keep polling briefly past expiry in case a payment clears right at the deadline.

**Technical Details:**
- **Initiation:** `POST /deposits` claims user-scoped `idempotency_keys` (`POST:/deposits:<userId>`, `IN_PROGRESS`, DB-clock `NOW() + 60s` `locked_until`, fenced by `lease_version` + `locked_until > NOW()`), inserts `INITIATED`, calls `POST /psp/payments` (`amount_irt * 10` IRR), commits `AWAITING_PAYMENT` + `psp_token` + `expires_at` (`+30m`) asserting `.returning()` row count === 1 (rolling back `409` if `DepositPoller` already expired the row) *before* returning `201`. Orphaned `INITIATED` rows (`psp_token IS NULL`) past 65s expire safely to `FAILED`.
- **Verification & Recovery:** Unsigned PSP callbacks (`{token, orderId, status: "OK"|"NOK"}`) act as wake-up hints only (never mark `FAILED`), and safely backfill missing `psp_token` via `GET /psp/payments/{token}` `orderId` verification if needed. Callers query `GET /psp/payments/{token}` before `POST /psp/verify`, verify `orderId` matching (recording `ORDER_ID_MISMATCH` and retrying until expiry while holding credit), fence unsettled transitions via `(status, version)` CAS, and preserve a post-expiry `DEPOSIT_EXPIRY_GRACE_MS` polling schedule so late `PAID` confirmations recover `FAILED → SUCCEEDED`. Both `code: 100 ("OK")` and `code: 101 ("ALREADY_VERIFIED")` can settle exact `verified_amount` (`÷ 10n` IRT) and flag `AMOUNT_MISMATCH` on differing totals or non-10x IRR remainders (`hasIrrRemainder`). Overpayments, invalid verified amounts, and reused PSP references remain in verification with a discrepancy and zero credit.
- **Settlement Reconciliation:** `/reconciliation/run` normalizes `شماره پیگیری` (`000`-strip/trim), Persian digits, `rowNumber`-aware duplicate rows, negative deposit safety, and `واریز درگاه` lines using index-friendly `RECONCILIATION_TZ` ranges while consuming matched local deposits once and reporting `MATCHED_ADJACENT_DAY` within 15 minutes of midnight. The first exact match records the settlement date so duplicate appearances on another date surface as discrepancies.

### Withdrawal State Machine
`PENDING_DISPATCH` → `DISPATCHING` → `PROCESSING` → `SUCCEEDED` | `FAILED` *(plus `MANUAL_REVIEW` for unresolved states)*

**Simple Intuition:**
Lock the user's money (`AVAILABLE → LOCKED`) and reserve their daily quota inside a fast DB transaction *before* making any external API call. Then let background workers claim queued withdrawals with a lease (so two workers never send the same transfer twice), keep retrying on transient errors (`503`, timeouts, even `404`), and freeze/escalate to `MANUAL_REVIEW` if anything drags on too long or a webhook payload doesn't match what we stored.

**Technical Details:**
- **Validation, TX1 & Cancellation *(Ambiguity #3)*:** Pre-validation user-scoped `Idempotency-Key` claim/replay runs *first* (invalid reuse yields `422 IDEMPOTENCY_KEY_REUSED`), followed inside the TX by `MAX_AMOUNT_MINOR` bounds, `400 INVALID_DESTINATION` (ISO-13616 Mod-97 IBAN / Base58Check TRC20), `422 BELOW_MINIMUM` (`100,000` IRT / `10` USDT), runtime `system_controls` currency pause (`503 SERVICE_PAUSED`), canonical locks, `outbound_frozen` (`403`), `DAILY_LIMIT_EXCEEDED` (`200M` IRT eq.), and `INSUFFICIENT_FUNDS`; executes `WD_HOLD`, increments `user_daily_limits`, and inserts `PENDING_DISPATCH` with pre-generated `provider_request_id` (`version = 1`). Cancellation (`POST /withdrawals/:id/cancel`) requires `Idempotency-Key` and checks the owner ID, is idempotent (`200 OK` if already `CANCELLED_BY_USER`), and is allowed strictly before dispatch (`409` once `DISPATCHING`+).
- **Dispatch & TOCTOU Fencing:** `WithdrawalDispatcher` claims `PENDING_DISPATCH` via `SKIP LOCKED`, increments `version`, sets `lease_until = now() + computeSafeLeaseMs(45s, timeoutMs, 2, 15s)` (strictly exceeding `PROVIDER_HTTP_TIMEOUT_MS`), commits `DISPATCHING`, and calls `POST /payout/transfers`. Definitely rejected `4xx` responses release funds; `5xx`/timeouts compute short jittered exponential backoff (`computeJitteredBackoffMs`, avoiding 45s stalls), query `GET /payout/transfers/{provider_request_id}` on recovery, re-POST with identical `provider_request_id` on `404`, and escalate to `MANUAL_REVIEW` from either `DISPATCHING` or `PROCESSING` once `age >= WD_MANUAL_REVIEW_SLA_MS`. When `pollProcessingBatch` sees `404` on an unaccepted `MANUAL_REVIEW` row (`provider_ref_id IS NULL`), it atomically CAS-reclaims `status = 'DISPATCHING'` with a fresh dispatch lease and `version + 1` before calling `createTransfer`, avoiding concurrent duplicate `POST`s while never blindly re-POSTing previously accepted (`provider_ref_id IS NOT NULL`) rows.
- **Webhooks, Returns & Late-Success *(Ambiguity #1)*:** Payout webhooks validate raw-body HMAC-SHA256 hex signatures (`401` on invalid), check optional payload `amount`/`currency` against stored withdrawal values (logging `PAYOUT_PAYLOAD_MISMATCH` and **halting** into `MANUAL_REVIEW` with `next_poll_at = NULL` without settling or releasing), lock `FOR UPDATE` + pre-scaffold `[AVAILABLE, IRT RECEIVABLE, USDT RECEIVABLE]`, and delegate to pure `decideWithdrawalTransition`. Out-of-order `RETURNED`/`REVERSED` on unsettled states sets `terminal_return = true` (blocking subsequent delayed `SUCCEEDED` webhooks); signed late-success webhooks on failed withdrawals schedule a durable inquiry before calling `GET /payout/transfers/{id}`. An inconclusive inquiry returns `503` while polling continues; legitimate `WD_LATE_SUCCESS` restores `user_daily_limits` usage; explicit `RETURNED`/`REVERSED` settlements post `WD_RETURN`, credit `USER:RECEIVABLE` first to retire any prior late-success debt before crediting `USER:AVAILABLE`, and clear automatic receivable freezes once all receivables reach zero and preserve incident and AML freezes. Operations can resolve stuck `MANUAL_REVIEW` rows and their payload discrepancies via `POST /internal/withdrawals/:id/resolve`.

---

## 4. Key Assumptions

**Simple Intuition:**
Keep money exact in integer minor units, convert between Tomans and Rials strictly at the external provider boundary, and apply the `200M` Toman daily cap on Tehran calendar days across both currencies combined.

1. **Unit Boundary:** API amounts are strings (`IRT` integer Toman; `USDT` up to 6 decimals). **Both** PSP and Payout (`IRR`) expect Rials (`1 IRT = 10 IRR`), translated exclusively inside `ProvidersModule` (`docs/provider-notes.md`).
2. **Minimum IRT Withdrawal:** `100,000` Toman per Business Rules (env-configurable; Appendix A's `50,000` is illustrative).
3. **Daily Limit *(Ambiguity #2)*:** `200,000,000` Toman per `Asia/Tehran` (`00:00`) day across `IRT + USDT` combined (`USDT` converted via integer ceiling `(amount_minor * fx_rate_irt + 999_999n) / 1_000_000n` with snapshotted `USDT_IRT_RATE`; `FAILED`/`RETURNED`/cancelled release quota).
4. **Arithmetic & Keys:** Zero floats (`NUMERIC(38,0)` minor units in Postgres + `bigint` in TS); `UUIDv7` entity PKs + `BIGINT` identity ledger cursor; lazy user account creation.

---

## 5. Architecture Decision Records (ADRs)

- **ADR-01: PostgreSQL Row-Level Locking Over Redis Distributed Locks**
  - *Simple Intuition:* One database is simpler and safer than trying to keep Redis locks or caches in sync with Postgres under load.
  - *Options:* (A) Redis Redlock/counters; (B) PostgreSQL `FOR UPDATE` + `SKIP LOCKED` + `CHECK`. *Decision:* Option B.
  - *Trade-off:* Higher hot-row contention at extreme scale (Phase 1: Postgres sub-buckets/micro-batching; Phase 2: hot-ledger offload to **TigerBeetle** using `UUIDv7` `u128` idempotency), but eliminates Redis split-brain, cache-DB drift, and negative-balance races on Redis CPU saturation.
- **ADR-02: DB-Materialized Double-Entry `accounts`/`ledger_items` with Minor-Unit `NUMERIC(38,0)` & Unupdated `SYSTEM` Accounts**
  - *Simple Intuition:* If PostgreSQL itself derives user balances from balanced ledger inserts and blocks direct edits or negative balances, application bugs cannot cause balance drift—and leaving system accounts unupdated avoids global lock bottlenecks.
  - *Options:* (A) App-updated wallet balance columns or locked system rows; (B) Immutable `ledger_items` + `BEFORE INSERT` balance-projection trigger (`pg_trigger_depth()` guard forbidding direct SQL edits) + app-layer balanced-posting validation (`LedgerService`), `normal_side`-typed `NUMERIC(38,0)` (`balance >= 0` everywhere), `balance IS NULL` on `SYSTEM`. *Decision:* Option B.
  - *Trade-off:* Extra hold/release rows and trigger overhead, but mathematically prevents balance-vs-ledger drift (`SUM(CREDIT) - SUM(DEBIT) == balance` for liabilities, vice versa for assets), negative balances, float error, and global clearing-row contention.
- **ADR-03: Commit-First Async Payout Dispatch with `version`-Fenced Leases & No Timeout Auto-Fail**
  - *Simple Intuition:* Commit the hold in our database before talking to the bank, let workers claim it with an expiring lease, and never guess that a timed-out payout failed.
  - *Options:* (A) Inline Payout inside `POST /withdrawals` and auto-fail on timeout; (B) Persist hold + `provider_request_id` in TX1, dispatch async with `version` CAS (`timeout < lease`), escalate prolonged ambiguity to `MANUAL_REVIEW`. *Decision:* Option B.
  - *Trade-off:* Async payout completion and longer holds during outages, but prevents double payouts, TOCTOU zombie overwrites, and premature refunds on unknown bank outcomes.
- **ADR-04: Modular Monolith Over Microservices**
  - *Simple Intuition:* Don't split one local ACID money transaction into network calls across microservices unless forced to.
  - *Options:* (A) Split Wallet/Ledger/Withdrawal/Limits into microservices with 2PC/Sagas; (B) NestJS Modular Monolith over shared ACID PostgreSQL. *Decision:* Option B.
  - *Trade-off:* Shared DB deployment unit, but eliminates partial-failure Saga windows and scales horizontally via stateless API/worker pods (proven at extreme financial throughput by Shopify's BFCM Modular Monolith).
