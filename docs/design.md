# T-103: Crypto Exchange Wallet & Double-Entry Ledger — Design Document

**Version:** v1.1 (Updated Post-Simulator Probe) | **Stack:** NestJS 12, TypeScript, PostgreSQL 18, Drizzle ORM (`pg`), RabbitMQ (bonus), No Redis  
*Empirical behaviors captured from `hamtapay/t103-simulator:1.0` (`default` & `hostile`) are logged with evidence in [`docs/provider-notes.md`](./provider-notes.md).*

---

## 1. Service & Module Boundaries

**NestJS Modular Monolith** over Microservices: keeps Wallet, Ledger, Limits, and Outbox inside single-DB ACID transactions—eliminating distributed `2PC`/Saga drift—while scaling horizontally via stateless replicas (like Shopify's BFCM Modular Monolith), with PostgreSQL as sole source of truth and a global `ExceptionFilter` enforcing `{"code", "message"}` on all errors:

- **`WalletModule` & `LedgerModule`**: Lazy user sub-accounts (`AVAILABLE`, `LOCKED`, `RECEIVABLE`), DB-materialized double-entry engine (`LedgerService.postTransaction()` atomically writes `outbox_events` in the same TX whenever any `USER` balance changes), `GET /wallets/:userId` (`200` with `"0"` balances for unseen users, never `404`), and keyset-paginated `GET /wallets/:userId/ledger` (defaults to `AVAILABLE`; `?accountType=ALL` optional).
- **`IdempotencyModule`**: Route-scoped `PK(scope, key)` + canonical key-sorted JSON SHA-256 `request_hash` (`422 IDEMPOTENCY_KEY_REUSED` on mismatch). On DB-only POSTs (`/withdrawals`, `/transfers`, `/internal/adjustments`), **Statement #1** of the `READ COMMITTED` TX is `INSERT INTO idempotency_keys (..., 'IN_PROGRESS') ON CONFLICT (scope, key) DO NOTHING`: PostgreSQL's PK index blocks concurrent identical retries until the winner updates `COMPLETED` (`201`), so waiters read and replay `201` *before* touching `accounts` (never falsely returning `422 INSUFFICIENT_FUNDS`), while `4xx` rollbacks leave retries uncached. External-PSP `POST /deposits` commits a 60s `IN_PROGRESS` lease (`locked_until`) before calling PSP (`409 IDEMPOTENCY_IN_PROGRESS` while active; recoverable on crash).
- **`DepositModule`**: Initiates PSP payments (`POST /deposits`), treats unsigned callbacks as wake-up hints only, uses `next_poll_at` lease claims as **singleflight leader election** before `/psp/verify`, and runs `DepositPoller` for dropped callbacks, crashes, and 30m unpaid TTL expiry.
- **`WithdrawalModule`**: Validates destination/minimum/restrictions/limits, holds funds (`AVAILABLE → LOCKED`), supports pre-dispatch cancel (`PENDING_DISPATCH`), dispatches payouts via `SKIP LOCKED` + `version` fencing, verifies raw-body HMAC-SHA256 webhooks, polls stalled payouts, reverses bank returns, and resolves late-success conflicts.
- **`AdjustmentModule`**: `POST /internal/adjustments` guarded by `InternalOpsGuard` with optional timing-safe `INTERNAL_API_KEY` + `INTERNAL_ALLOWED_IPS` (unset by default in `docker-compose.yml` for Appendix A grading; paired in production with internal-only mTLS, short-lived OIDC, and Maker-Checker approval; `X-Operator-Id` defaults to `'system-ops'`), requiring `reason`.
- **`ProvidersModule`**: Isolated HTTP adapters (`PspClient`, `PayoutClient`) for timeouts, raw-body lowercase-hex HMAC verification, `IRT × 10 ↔ IRR` conversion on **both** PSP and Payout, and Persian/dirty-CSV normalization.
- **Bonus Modules**: `TransferModule` (`POST /transfers`, rejects `fromUserId === toUserId` with `400`), `ReconciliationModule` (`POST /reconciliation/run` read-only CSV diff deduplicating duplicate lines, normalizing Persian digits/`000`-padded refs, filtering `واریز درگاه`), and `OutboxModule` (RabbitMQ `ConfirmChannel` + `lease_until` + non-blocking auto-reconnect so Broker outages never block boot/writes + `processed_events` dedup).

**Multi-Instance Coordination:** Stateless instances share no in-memory locks; workers (`DepositPoller`, `WithdrawalDispatcher`, `WithdrawalPoller`, `OutboxRelay`) claim work with `SELECT ... FOR UPDATE SKIP LOCKED`, `lease_until`, and a monotonic `version` fencing token on withdrawals.

---

## 2. Data Model (Tables, Keys, Indexes & Constraints)

All entity PKs use time-ordered **`UUIDv7`** (`uuid`). Monetary columns use **`NUMERIC(38,0)` minor units** (`1 IRT = 1 Toman`, `1 USDT = 1,000,000 micro-USDT`), mapping 1:1 to TypeScript `bigint` with zero floats.

| Table | Key Columns & Types | Constraints & Critical Indexes |
| --- | --- | --- |
| `accounts` | `id UUIDv7 PK`, `owner_type` (`USER\|SYSTEM`), `owner_id`, `currency` (`IRT\|USDT`), `account_type` (`AVAILABLE\|LOCKED\|RECEIVABLE\|CLEARING\|ADJUSTMENT\|REVENUE`), `normal_side` (`DEBIT\|CREDIT`), `balance NUMERIC(38,0)` (`NULL` on `SYSTEM`) | `UNIQUE(owner_type, owner_id, currency, account_type)`; `CHECK ((owner_type = 'SYSTEM' AND balance IS NULL) OR (owner_type = 'USER' AND balance >= 0))`; `BEFORE UPDATE OF balance WHEN (pg_trigger_depth() = 0)` forbids direct SQL edits |
| `ledger_transactions` | `id UUIDv7 PK`, `type`, `reference_type`, `reference_id`, `description`, `metadata JSONB`, `created_at` | `UNIQUE(reference_type, reference_id, type)`; append-only trigger; `DEFERRABLE INITIALLY DEFERRED` commit trigger enforcing `COUNT(*) >= 2` and per-currency `SUM(DEBIT) = SUM(CREDIT)` |
| `ledger_items` | `id BIGINT GENERATED ALWAYS AS IDENTITY PK`, `transaction_id FK`, `account_id FK`, `user_id`, `account_type`, `currency` (`IRT\|USDT`), `direction` (`DEBIT\|CREDIT`), `amount NUMERIC(38,0)`, `balance_after` (`NULL` on `SYSTEM`) | Append-only trigger; `BEFORE INSERT` trigger verifies parent TX belongs to `pg_current_xact_id()`, updates `USER` `accounts.balance` via `normal_side`, and sets `balance_after`; `CHECK (amount > 0)`; partial index `(user_id, account_type, id DESC) WHERE user_id IS NOT NULL` |
| `user_daily_limits` | `user_id TEXT`, `limit_date DATE`, `used_irt_amount NUMERIC(38,0)` | `PK(user_id, limit_date)`, `CHECK (used_irt_amount >= 0)` |
| `user_restrictions` | `user_id TEXT PK`, `outbound_frozen BOOLEAN`, `freeze_reason TEXT`, `updated_at` | Checked inside **both** `/withdrawals` and `/transfers` before balance hold |
| `idempotency_keys` | `scope TEXT`, `key TEXT`, `request_hash`, `status`, `response_status`, `response_body JSONB`, `locked_until`, `expires_at` | `PK(scope, key)`; index on `expires_at` |
| `deposits` | `id UUIDv7 PK`, `user_id`, `requested_amount`, `verified_amount`, `amount_mismatch BOOLEAN`, `order_id UNIQUE`, `psp_token UNIQUE`, `psp_ref_id`, `status`, `expires_at`, `next_poll_at`, `verified_at` | Partial index `(next_poll_at) WHERE status IN ('INITIATED','AWAITING_PAYMENT','VERIFYING')`; partial index `(verified_at) WHERE status = 'SUCCEEDED'`; index on `psp_ref_id` |
| `withdrawals` | `id UUIDv7 PK`, `user_id`, `currency`, `amount`, `fee`, `fx_rate_irt`, `irt_equivalent`, `limit_date`, `quota_released BOOLEAN`, `destination`, `provider_request_id VARCHAR(64) UNIQUE`, `provider_ref_id`, `status`, `failure_reason`, `late_success_conflict BOOLEAN`, `version BIGINT`, `lease_until`, `next_poll_at` | Partial index `(created_at) WHERE status IN ('PENDING_DISPATCH','DISPATCHING')`; partial index `(next_poll_at) WHERE status IN ('PROCESSING','MANUAL_REVIEW')` |
| `adjustments` | `id UUIDv7 PK`, `user_id`, `currency`, `amount`, `reason`, `operator_id`, `created_at` | Audit record referenced by `OPS_ADJ` ledger transaction |
| `financial_discrepancies` | `id UUIDv7 PK`, `reference_type` (`DEPOSIT\|WITHDRAWAL`), `reference_id UUID`, `user_id`, `discrepancy_type`, `amount`, `currency`, `provider_payload JSONB`, `status` | Index `(user_id, status)` for Ops triage (`AMOUNT_MISMATCH`, `LATE_SUCCESS_CONFLICT`) |
| `transfers` / `outbox_events` / `processed_events` *(bonus)* | `transfers(id, from_user_id, to_user_id, currency, amount)`; `outbox_events(id, event_type, payload, status, lease_until, next_retry_at)`; `processed_events(event_id, consumer_name)` | `transfers(from_user_id, created_at DESC)`; `outbox` partial `(next_retry_at) WHERE status='PENDING'`; `PK(event_id, consumer_name)` |

### Double-Entry Posting Matrix (`CREDIT = +` on `CREDIT`-normal `AVAILABLE`/`LOCKED`/`FEE_REVENUE`; `DEBIT = +` on `DEBIT`-normal `RECEIVABLE`/clearing)

| Event (`type`) | Debit Account(s) | Credit Account(s) |
| --- | --- | --- |
| Deposit Succeeded (`DEPOSIT`) | `SYSTEM:PSP_CLEARING` (`verified`, `+`) | `USER:{id}:IRT:AVAILABLE` (`verified`, `+`) |
| Ops Credit (`OPS_ADJ`) | `SYSTEM:OPS_ADJUSTMENT` (`+`) | `USER:{id}:{ccy}:AVAILABLE` (`+`) |
| Withdrawal Hold (`WD_HOLD`) | `USER:{id}:{ccy}:AVAILABLE` (`amount + fee`, `-`) | `USER:{id}:{ccy}:LOCKED` (`amount + fee`, `+`) |
| Withdrawal Succeeded (`WD_SETTLE`) | `USER:{id}:{ccy}:LOCKED` (`amount + fee`, `-`) | `SYSTEM:PAYOUT_CLEARING` (`amount`), `SYSTEM:FEE_REVENUE` (`fee` if > 0) |
| Withdrawal Failed / Cancelled (`WD_RELEASE`) | `USER:{id}:{ccy}:LOCKED` (`amount + fee`, `-`) | `USER:{id}:{ccy}:AVAILABLE` (`amount + fee`, `+`) |
| Bank Return (`WD_RETURN`) | `SYSTEM:PAYOUT_CLEARING` (`amount`), `SYSTEM:FEE_REVENUE` (`fee` if > 0) | `USER:{id}:{ccy}:AVAILABLE` (`amount + fee`, `+`) |
| Late-Success Conflict *(Ambiguity #1)* (`WD_LATE_SUCCESS`) | `USER:AVAILABLE` (`clawback`, `-`), `USER:RECEIVABLE` (`shortfall`, `+ >= 0`) | `SYSTEM:PAYOUT_CLEARING` (`amount`), `SYSTEM:FEE_REVENUE` (`fee` if > 0) |
| Internal Transfer *(bonus)* (`TRANSFER`) | `USER:{from}:{ccy}:AVAILABLE` (`-`) | `USER:{to}:{ccy}:AVAILABLE` (`+`) |

**Canonical Lock Order:** Lazy `INSERT ... ON CONFLICT DO NOTHING` upserts run deterministically sorted by `(owner_type, owner_id, currency, account_type) ASC` (or autocommit pre-ensure) *before* acquiring `SELECT ... FOR UPDATE` locks in strict order: `idempotency_keys (scope, key)` → `user_daily_limits (user_id, limit_date)` → `user_restrictions (user_id)` → **`USER` `accounts` sorted by `id ASC`** (deadlock-free even on brand-new users). `SYSTEM` accounts keep `balance IS NULL` and are never locked or updated.

---

## 3. State Machines (Deposits & Withdrawals)

### Deposit State Machine
`INITIATED` → `AWAITING_PAYMENT` → `VERIFYING` → `SUCCEEDED` | `FAILED`

- **Initiation:** `POST /deposits` claims leased `idempotency_keys` (`IN_PROGRESS`, `locked_until = now + 60s`), inserts `INITIATED`, calls `POST /psp/payments` (`amount_irt * 10` IRR), persists `AWAITING_PAYMENT` + `psp_token` + `expires_at` (`+30m`) *before* returning `201`. Because `POST /psp/payments` `orderId` is **not** idempotent on the simulator (duplicate `orderId` mints a second `psp_token`), orphaned `INITIATED` rows (`psp_token IS NULL`) past their 60s lease were never exposed to a user and expire safely to `FAILED`.
- **Verification & Recovery:** Unsigned PSP callbacks (`{token, orderId, status: "OK"|"NOK"}`) act as wake-up hints only (never mark `FAILED`). Because `/psp/verify` returns `code: -51 / status: "FAILED"` even on **unpaid `INIT` tokens**, callers claim a short `next_poll_at` singleflight lease and **query `GET /psp/payments/{token}` before calling `POST /psp/verify`** (`INIT` waits until `expires_at`; `PAID`/`VERIFIED` verifies). Both `code: 100 ("OK")` and `code: 101 ("ALREADY_VERIFIED")` are verified successes (`amount` is string IRR → `÷ 10n` IRT); `503 {code: -1}` retries in `VERIFYING`. On verified success, **never fail on amount mismatch**: credit exact `verified_amount`, set `SUCCEEDED` + `verified_at`, and log `financial_discrepancies`. `/reconciliation/run` normalizes `شماره پیگیری` (`000`-strip/trim), Persian digits, duplicate rows, and `واریز درگاه` lines against `psp_ref_id` + `verified_at`.

### Withdrawal State Machine
`PENDING_DISPATCH` → `DISPATCHING` → `PROCESSING` → `SUCCEEDED` | `FAILED` *(plus `MANUAL_REVIEW` for unresolved states)*

- **Validation, TX1 & Cancellation *(Ambiguity #3)*:** Order: `Idempotency` → `400 INVALID_DESTINATION` (ISO-13616 Mod-97 IBAN / Base58Check TRC20 — required upfront because Payout accepts invalid IBANs with `202` before later failing) → `422 BELOW_MINIMUM` (`100,000` IRT / `10` USDT) → TX1: Statement #1 `idempotency_keys` claim → canonical locks → `outbound_frozen` (`403`) → `DAILY_LIMIT_EXCEEDED` (`200M` IRT eq.) → `INSUFFICIENT_FUNDS`; executes `WD_HOLD`, increments `user_daily_limits`, and inserts `PENDING_DISPATCH` with pre-generated `provider_request_id` (`version = 1`). Cancellation is allowed **only** in `PENDING_DISPATCH` via atomic `UPDATE ... WHERE status = 'PENDING_DISPATCH'`, releasing funds and daily quota.
- **Dispatch & TOCTOU Fencing:** `WithdrawalDispatcher` claims `PENDING_DISPATCH` via `SKIP LOCKED`, increments `version`, sets `lease_until = now() + 45s`, commits `DISPATCHING`, and calls `POST /payout/transfers` (`10s` timeout; `202` new / `200` duplicate `requestId`). Completion writes fence via `WHERE id = $1 AND status = 'DISPATCHING' AND version = $expected`. Definite `4xx` rejections transition to `FAILED` (`WD_RELEASE` + quota refund); `503 UPSTREAM_UNAVAILABLE`/timeouts/socket resets never auto-fail—empirically, `503`/dropped sockets can return `404` on initial `GET` yet **succeed asynchronously later**, so recovery increments `version`, queries `GET /payout/transfers/{provider_request_id}`, and on `404` re-POSTs using the **identical `provider_request_id`**.
- **Webhooks, Returns & Late-Success *(Ambiguity #1)*:** Payout webhooks validate hex format & byte-length *before* `crypto.timingSafeEqual` on the **raw body** (`401` on invalid signatures, rejecting spoofed `FAILED` events in `hostile` mode), lock `FOR UPDATE` + `version++`, and allow strictly forward transitions `DISPATCHING | PROCESSING | MANUAL_REVIEW → SUCCEEDED | FAILED` (ignoring duplicate events and stale `PROCESSING` webhooks delivered after `SUCCEEDED`). `5xx`/timeouts poll with brisk capped backoff so `hostile` chaos converges to terminal states, escalating to `MANUAL_REVIEW` only after prolonged SLA while continuing background polls. Explicit provider return/reversal statuses transition `SUCCEEDED → FAILED` (`failure_reason = 'RETURNED'`), post `WD_RETURN`, and refund quota. If a late `SUCCEEDED` arrives for a `FAILED` row, we lock `USER:AVAILABLE` and `USER:RECEIVABLE`, claw back `min(available, owed)`, book only the shortfall (`>= 0`) to `USER:RECEIVABLE`, post `WD_LATE_SUCCESS`, open `financial_discrepancies`, and set `outbound_frozen = true`.

---

## 4. Key Assumptions

1. **Unit Boundary:** API amounts are strings (`IRT` integer Toman; `USDT` up to 6 decimals). **Both** PSP and Payout (`IRR`) expect Rials (`1 IRT = 10 IRR`), translated exclusively inside `ProvidersModule` (`docs/provider-notes.md`).
2. **Minimum IRT Withdrawal:** `100,000` Toman per Business Rules (env-configurable; Appendix A's `50,000` is illustrative).
3. **Daily Limit *(Ambiguity #2)*:** `200,000,000` Toman per `Asia/Tehran` (`00:00`) day across `IRT + USDT` combined (`USDT` converted via integer ceiling `(amount_minor * fx_rate_irt + 999_999n) / 1_000_000n` with snapshotted `USDT_IRT_RATE`; `FAILED`/`RETURNED`/cancelled release quota).
4. **Arithmetic & Keys:** Zero floats (`NUMERIC(38,0)` minor units in Postgres + `bigint` in TS); `UUIDv7` entity PKs + `BIGINT` identity ledger cursor; lazy user account creation.

---

## 5. Architecture Decision Records (ADRs)

- **ADR-01: PostgreSQL Row-Level Locking Over Redis Distributed Locks**
  - *Options:* (A) Redis Redlock/counters; (B) PostgreSQL `FOR UPDATE` + `SKIP LOCKED` + `CHECK`. *Decision:* Option B.
  - *Trade-off:* Higher hot-row contention at extreme scale (Phase 1: Postgres sub-buckets/micro-batching; Phase 2: hot-ledger offload to **TigerBeetle** using `UUIDv7` `u128` idempotency), but eliminates Redis split-brain, cache-DB drift, and negative-balance races on Redis CPU saturation.
- **ADR-02: DB-Materialized Double-Entry `accounts`/`ledger_items` with Minor-Unit `NUMERIC(38,0)` & Unupdated `SYSTEM` Accounts**
  - *Options:* (A) App-updated wallet balance columns or locked system rows; (B) Immutable `ledger_items` + `BEFORE INSERT` balance-projection trigger (`pg_trigger_depth()` guard forbidding direct SQL edits) + per-currency deferred zero-sum trigger on `ledger_transactions`, `normal_side`-typed `NUMERIC(38,0)` (`balance >= 0` everywhere), `balance IS NULL` on `SYSTEM`. *Decision:* Option B.
  - *Trade-off:* Extra hold/release rows and trigger overhead, but mathematically prevents balance-vs-ledger drift (`SUM(CREDIT) - SUM(DEBIT) == balance` for liabilities, vice versa for assets), negative balances, float error, and global clearing-row contention.
- **ADR-03: Commit-First Async Payout Dispatch with `version`-Fenced Leases & No Timeout Auto-Fail**
  - *Options:* (A) Inline Payout inside `POST /withdrawals` and auto-fail on timeout; (B) Persist hold + `provider_request_id` in TX1, dispatch async with `version` CAS (`timeout < lease`), escalate prolonged ambiguity to `MANUAL_REVIEW`. *Decision:* Option B.
  - *Trade-off:* Async payout completion and longer holds during outages, but prevents double payouts, TOCTOU zombie overwrites, and premature refunds on unknown bank outcomes.
- **ADR-04: Modular Monolith Over Microservices**
  - *Options:* (A) Split Wallet/Ledger/Withdrawal/Limits into microservices with 2PC/Sagas; (B) NestJS Modular Monolith over shared ACID PostgreSQL. *Decision:* Option B.
  - *Trade-off:* Shared DB deployment unit, but eliminates partial-failure Saga windows and scales horizontally via stateless API/worker pods (proven at extreme financial throughput by Shopify's BFCM Modular Monolith).
