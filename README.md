# Hamta Pay T-103 — Crypto Exchange Wallet & Double-Entry Ledger

A crash-safe **NestJS 12 (ESM) + PostgreSQL 18 + Drizzle ORM + RabbitMQ** modular monolith implementing exchange wallets (`IRT` & `USDT`), immutable double-entry accounting, PSP deposits, IBAN/TRC20 withdrawals, atomic P2P transfers, transactional outbox publishing, and dirty Persian CSV settlement reconciliation — with **zero Redis** and **zero floating-point math**.

---

## Key Architectural Guarantees

- **Zero Floating-Point Arithmetic:** All money uses `NUMERIC(38,0)` minor units in PostgreSQL and exact `bigint` values in TypeScript (`1 IRT = 1 Toman`, `1 USDT = 1,000,000 micro-USDT`), bounded at `MAX_AMOUNT_MINOR = 10^15` (`400 INVALID_REQUEST` on overflow). `IRT × 10 <-> IRR` translation occurs exclusively at external PSP/Payout boundaries (`ProvidersModule`).
- **Database-Enforced Double-Entry Integrity:**
  - `trg_accounts_no_direct_balance_update` blocks direct `UPDATE accounts.balance`; `trg_accounts_immutable_meta` forbids non-zero `USER` account `INSERT`s and immutable metadata/`normal_side` changes; `BEFORE TRUNCATE` triggers protect append-only `ledger_transactions` and `ledger_items`.
  - Balances mutate **only** inside `BEFORE INSERT ON ledger_items` in the exact same ACID transaction as the balanced `ledger_transactions` commit (dual `DEFERRABLE` commit triggers on **both** `ledger_transactions` and `ledger_items` enforce per-currency `SUM(DEBIT) = SUM(CREDIT)` and `COUNT(*) >= 2`, blocking `SET CONSTRAINTS ... IMMEDIATE` bypasses).
  - `CHECK ((owner_type = 'SYSTEM' AND balance IS NULL) OR (owner_type = 'USER' AND balance >= 0))` makes negative user balances mathematically impossible.
- **Deadlock-Free Concurrency, Pre-Validation User-Scoped Idempotency & Daily Cap:** `IdempotencyPreCheckGuard` hashes raw payloads (`422 IDEMPOTENCY_KEY_REUSED` before `ValidationPipe`), Statement-#1 `idempotency_keys` claims (`PK(scope, key)` with user IDs in customer scopes, cached domain `400`/`422` responses, DB-clock `NOW()` `lease_version` fencing on `/deposits`, and `Idempotency-Key` on `/cancel` and `/resolve`) precede Canonical Lock Order (`user_daily_limits` -> `user_restrictions` -> `USER` `accounts` ordered by `id ASC`). `100` concurrent withdrawals serialize cleanly against balances and the `200,000,000` IRT daily quota (`Asia/Tehran` `00:00` boundary).
- **Chaos & Crash Resilience (`SIM_CHAOS=hostile` Verified):**
  - Pre-checks `GET /psp/payments/{token}` before calling `/psp/verify`, checks `orderId` mismatches (deduplicated with retries until expiry), flags sub-Toman IRR remainder truncation, quarantines overpayments and duplicate references, fences deposit initiation (failing `0`-row finalizations cleanly and backfilling missing `psp_token`s on verified callbacks) and unsettled transitions by `(status, version)`, and keeps a configurable post-expiry grace poll (`DEPOSIT_EXPIRY_GRACE_MS`).
  - Dispatches payouts with `FOR UPDATE SKIP LOCKED`, `version`-fenced leases scaled above `PROVIDER_HTTP_TIMEOUT_MS` (`computeSafeLeaseMs`), short jittered `503` retry backoff, `getTransfer` + identical `provider_request_id` recovery (including safe CAS re-dispatch for unaccepted `provider_ref_id IS NULL` `MANUAL_REVIEW` rows on `404`), constant-time raw-body HMAC verification, `PAYOUT_PAYLOAD_MISMATCH` halting into `MANUAL_REVIEW`, `SLA` escalation from both `DISPATCHING` and `PROCESSING` to `MANUAL_REVIEW`, `WD_RETURN` (`RECEIVABLE -> AVAILABLE` offset + auto-unfreeze), and Ambiguity #1 `WD_LATE_SUCCESS` protections (`terminal_return` + durable inquiry retries + daily quota restoration, immune to out-of-order `RETURNED -> SUCCEEDED` or `CANCELLED_BY_USER`).
- **Production Operations & Security:** `pg_advisory_lock` serializes concurrent replica migrations (via direct/session-mode `MIGRATION_DATABASE_URI`, provisioning the least-privilege `t103_app` DML runtime role with `DELETE` restricted strictly to `idempotency_keys`, `outbox_events`, and `processed_events`), runtime PostgreSQL and AMQP operations have deadlines, readiness fails `503` on `SIGTERM` drain, and internal routes require `INTERNAL_API_KEY` except with explicit local opt-in, `X-Request-Id` correlation propagates inbound/outbound, `RetentionWorker` purges expired operational rows, `DriftAuditWorker` maintains a TTL-cached single-flight `balanceDriftAccounts` gauge and automatically pauses withdrawals if drift is ever detected, and internal ops endpoints support receivable settlement, `MANUAL_REVIEW` resolution, and Prometheus `/internal/metrics/prometheus`. Note: use `RECONCILIATION_TZ=Asia/Tehran` in production for Iranian PSP Jalali settlement cutoffs (`UTC` matches the sandbox simulator).

---

## Quick Start (`Docker Compose`)

1. Load the external simulator image (once):
   ```bash
   docker load -i ../t103-simulator.tar.gz
   ```
2. Start PostgreSQL 18, RabbitMQ 4, Simulator (`SIM_CHAOS=default` or `hostile`), automatic lock-serialized DB migrations, and the NestJS API directly (safe local defaults are built in; optionally copy `.env.example` to `.env` to customize):
   ```bash
   docker compose up --build
   ```
3. Access the running service:
   - API base URL: `http://localhost:3000`
   - Swagger UI (when `SWAGGER_ENABLED=true`): `http://localhost:3000/api/docs`
   - Health probes: `GET /health`, `GET /health/liveness`, `GET /ready`, `GET /health/readiness`

---

## API Endpoints

| Method | Path | Mandatory/Bonus | Key Notes |
| --- | --- | --- | --- |
| `GET` | `/wallets/:userId` | Mandatory | Returns `IRT` & `USDT` `available`/`locked`/`receivable` (`"0"` if unseen) |
| `GET` | `/wallets/:userId/ledger` | Mandatory | Keyset-paginated with all sub-accounts by default. Filter with `accountType` and `currency`. |
| `POST` | `/internal/adjustments` | Mandatory | User-scoped `Idempotency-Key`; protected by `InternalOpsGuard` (requires `X-Internal-Api-Key` outside local opt-in) |
| `POST` | `/internal/receivables/settle` | Ops Hardening | Settles `USER:RECEIVABLE` from `USER:AVAILABLE` via `RECEIVABLE_SETTLE` and clears an automatic receivable freeze at zero; requires `Idempotency-Key` & `InternalOpsGuard` |
| `POST` | `/internal/withdrawals/:id/resolve` | Ops Hardening | Resolves a `MANUAL_REVIEW` withdrawal (`SUCCEEDED` \| `FAILED`) with CAS & audit trail; requires `Idempotency-Key` & `InternalOpsGuard` |
| `POST` | `/internal/controls/withdrawals-pause` | Ops Hardening | Runtime emergency kill-switch (`currencies: ['IRT' \| 'USDT']`) stored in `system_controls`. Requires `Idempotency-Key` and `InternalOpsGuard`. |
| `GET` | `/internal/metrics` | Ops Hardening | Counts for open discrepancies, `MANUAL_REVIEW`, pending outbox, paused currencies, and TTL-cached `DriftAuditWorker` `balanceDriftAccounts` gauge; requires `InternalOpsGuard` |
| `GET` | `/internal/metrics/prometheus` | Ops Hardening | Prometheus `0.0.4` text exposition of operational & drift gauges; requires `InternalOpsGuard` |
| `POST` | `/deposits` | Mandatory | User-scoped `Idempotency-Key` (`lease_version`-fenced 60s lease); initiates PSP payment (`IRT * 10` IRR) |
| `GET` | `/deposits/:id` | Mandatory | Returns deposit status (`INITIATED`, `AWAITING_PAYMENT`, `VERIFYING`, `SUCCEEDED`, `FAILED`) |
| `POST` | `/webhooks/psp/callback` | Mandatory | Unsigned wake-up hint; triggers authoritative PSP status inquiry + verify |
| `POST` | `/transfers` | Bonus | Atomic P2P transfer (`IRT` or `USDT`); requires user-scoped `Idempotency-Key`; blocks `fromUserId === toUserId` |
| `POST` | `/withdrawals` | Mandatory (`IRT`) / Bonus (`USDT`) | Validates IBAN (`IRT`) or TRC20 (`USDT`), minimum, pause kill-switch, daily quota, `outbound_frozen`; user-scoped `Idempotency-Key` |
| `GET` | `/withdrawals/:id` | Mandatory | Returns withdrawal status (`PENDING_DISPATCH`, `DISPATCHING`, `PROCESSING`, `MANUAL_REVIEW`, `SUCCEEDED`, `FAILED`) |
| `POST` | `/withdrawals/:id/cancel` | Bonus | Requires `Idempotency-Key` and `{"userId":"..."}`. Only the owner can cancel while pending dispatch. |
| `POST` | `/webhooks/payout` | Mandatory | Constant-time raw-body HMAC-SHA256 verification (`x-signature`) + payload mismatch auditing |
| `POST` | `/reconciliation/run` | Bonus | Protected by `InternalOpsGuard`; reconciles and records matched PSP settlement dates (`واریز درگاه`, Persian digits, `٬`, `000`-padded refs) |

Errors consistently follow `{"code": "...", "message": "..."}`.

## Access and upgrades

Set `APP_ENV` to `dev`, `stage`, or `production` for deployed environments. Internal routes always require `INTERNAL_API_KEY` outside `APP_ENV=local`. Local `docker-compose.yml` sets `APP_ENV=local` and `ALLOW_UNAUTHENTICATED_INTERNAL_OPS=true` so Appendix A endpoints work out of the box unless `INTERNAL_API_KEY` is configured.

Customer routes in deployed environments require a trusted gateway. Configure `WALLET_GATEWAY_KEY` with a separate secret of at least 32 characters. The gateway must authenticate the customer, discard client-supplied identity headers, and forward the verified subject in `X-Wallet-User-Id` with the shared secret in `X-Wallet-Gateway-Key`. Limit direct wallet service access to the gateway and trusted service callers.

Before applying migration `0006`, drain old API replicas and let in-flight deposit creation finish so legacy leases can complete in their original scope. The migration moves completed receipts into user scopes. A duplicate existing PSP reference blocks the unique index from being created until the underlying records are reconciled.

---

## Running Locally & Executing Tests

```bash
# Install dependencies & build
npm ci --ignore-scripts
npm run build

# Code quality checks
npm run lint
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
npx prettier --check "src/**/*.ts" "test/**/*.ts"

# Unit & property-based tests (Vitest + fast-check)
npm test

# PostgreSQL 18 Integration & 100-Concurrency Tests
# (requires running Postgres matching DATABASE_URI + applied migrations)
npm run db:migrate
npm run test:e2e

# Live Hostile Simulator + RabbitMQ E2E Chaos Test
# Point simulator webhooks at the host-run test app and enable hostile mode
PAYOUT_WEBHOOK_URL=http://host.docker.internal:3999/webhooks/payout SIM_CHAOS=hostile docker compose up -d postgres rabbitmq simulator
npm run test:e2e:hostile

# Export OpenAPI JSON to docs/openapi.json
npm run openapi:export
```

---

## Documentation & API Artifacts (`/docs`)

- Architecture & Data Model: [docs/design.md](./docs/design.md)
- Empirical Simulator Discoveries (`hostile` & `default`): [docs/provider-notes.md](./docs/provider-notes.md)
- Deliberate Ambiguities (#1 Mandatory, #2 & #3 Bonus): [docs/ambiguities.md](./docs/ambiguities.md)
- `02:10` AM Deployment Incident Analysis: [docs/incident-analysis.md](./docs/incident-analysis.md)
- 50x Scalability & TigerBeetle Evolution Analysis: [docs/scalability.md](./docs/scalability.md)
- Machine-readable OpenAPI Spec: [docs/openapi.json](./docs/openapi.json)
- Postman v2.1 Collection: [docs/t103-wallet.postman_collection.json](./docs/t103-wallet.postman_collection.json)
