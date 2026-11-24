# Hamta Pay T-103 — Crypto Exchange Wallet & Double-Entry Ledger

A crash-safe **NestJS 12 (ESM) + PostgreSQL 18 + Drizzle ORM + RabbitMQ** modular monolith implementing exchange wallets (`IRT` & `USDT`), immutable double-entry accounting, PSP deposits, IBAN/TRC20 withdrawals, atomic P2P transfers, transactional outbox publishing, and dirty Persian CSV settlement reconciliation — with **zero Redis** and **zero floating-point math**.

---

## Key Architectural Guarantees

- **Zero Floating-Point Arithmetic:** All money uses `NUMERIC(38,0)` minor units in PostgreSQL and exact `bigint` values in TypeScript (`1 IRT = 1 Toman`, `1 USDT = 1,000,000 micro-USDT`). API amounts are serialized strictly as decimal/integer strings. `IRT × 10 <-> IRR` unit translation occurs exclusively at external PSP/Payout boundaries (`ProvidersModule`).
- **Database-Enforced Double-Entry Integrity:**
  - Direct SQL updates to `accounts.balance` are blocked by `trg_accounts_block_direct_balance_update` (`pg_trigger_depth() <= 1` and session GUC guard).
  - Balances mutate **only** inside `BEFORE INSERT ON ledger_items` in the exact same ACID transaction as the balanced `ledger_transactions` commit (`DEFERRABLE` commit trigger enforces per-currency `SUM(DEBIT) = SUM(CREDIT)` and `COUNT(*) >= 2`).
  - `CHECK ((owner_type = 'SYSTEM' AND balance IS NULL) OR (owner_type = 'USER' AND balance >= 0))` makes negative user balances mathematically impossible.
- **Deadlock-Free Concurrency & Daily Cap:** Statement-#1 `idempotency_keys` claims (`PK(scope, key)` with SHA-256 canonical JSON hashes) precede Canonical Lock Order (`user_daily_limits` -> `user_restrictions` -> `USER` `accounts` ordered by `id ASC`). `100` concurrent withdrawals serialize cleanly against balances and the `200,000,000` IRT daily quota (`Asia/Tehran` `00:00` boundary).
- **Chaos & Crash Resilience (`SIM_CHAOS=hostile` Verified):**
  - Pre-checks `GET /psp/payments/{token}` before calling `/psp/verify`, surviving premature `-51` on `INIT`, `503` retries, `code 101` replays, and `AMOUNT_MISMATCH` logging.
  - Dispatches payouts with `FOR UPDATE SKIP LOCKED`, `version`-fenced leases, `getTransfer` + identical `provider_request_id` re-POST recovery on `503`/`404`, constant-time raw-body HMAC-SHA256 verification (`x-signature`), stale-webhook immunity, `WD_RETURN` reversals, `MANUAL_REVIEW` SLA escalation, and Ambiguity #1 `WD_LATE_SUCCESS` receivable recovery + outbound freeze.

---

## Quick Start (`Docker Compose`)

1. Load the external simulator image (once):
   ```bash
   docker load -i t103-simulator.tar.gz
   ```
2. Configure environment variables:
   ```bash
   cp .env.example .env
   ```
   *(Edit `.env` credentials/secrets as needed for local use; `.env` is gitignored.)*
3. Start PostgreSQL 18, RabbitMQ 4, Simulator (`SIM_CHAOS=default` or `hostile`), automatic DB migrations, and the NestJS API:
   ```bash
   docker compose up --build
   ```
4. Access the running service:
   - API base URL: `http://localhost:3000`
   - Swagger UI (when `SWAGGER_ENABLED=true`): `http://localhost:3000/api/docs`
   - Health probes: `GET /health`, `GET /health/liveness`, `GET /ready`, `GET /health/readiness`

---

## API Endpoints

| Method | Path | Mandatory/Bonus | Key Notes |
| --- | --- | --- | --- |
| `GET` | `/wallets/:userId` | Mandatory | Returns `IRT` & `USDT` `available`/`locked`/`receivable` (`"0"` if unseen) |
| `GET` | `/wallets/:userId/ledger` | Mandatory | Keyset-paginated (`limit`, `cursor`, `accountType`, `currency`) |
| `POST` | `/internal/adjustments` | Mandatory | Requires `Idempotency-Key`; optional `X-Internal-Api-Key` / IP allowlist (fail-closed in `production`) |
| `POST` | `/deposits` | Mandatory | Requires `Idempotency-Key` (60s crash-recoverable lease); initiates PSP payment (`IRT * 10` IRR) |
| `GET` | `/deposits/:id` | Mandatory | Returns deposit status (`INITIATED`, `AWAITING_PAYMENT`, `VERIFYING`, `SUCCEEDED`, `FAILED`) |
| `POST` | `/webhooks/psp/callback` | Mandatory | Unsigned wake-up hint; triggers authoritative PSP status inquiry + verify |
| `POST` | `/transfers` | Bonus | Atomic P2P transfer (`IRT` or `USDT`); requires `Idempotency-Key`; blocks `fromUserId === toUserId` |
| `POST` | `/withdrawals` | Mandatory (`IRT`) / Bonus (`USDT`) | Validates IBAN (`IRT`) or TRC20 (`USDT`), minimum, daily quota, `outbound_frozen`; requires `Idempotency-Key` |
| `GET` | `/withdrawals/:id` | Mandatory | Returns withdrawal status (`PENDING_DISPATCH`, `DISPATCHING`, `PROCESSING`, `MANUAL_REVIEW`, `SUCCEEDED`, `FAILED`) |
| `POST` | `/withdrawals/:id/cancel` | Bonus | Allowed strictly in `PENDING_DISPATCH`; releases `LOCKED -> AVAILABLE` and daily quota |
| `POST` | `/webhooks/payout` | Mandatory | Constant-time raw-body HMAC-SHA256 verification (`x-signature`) |
| `POST` | `/reconciliation/run` | Bonus | Read-only reconciliation of PSP CSV (`واریز درگاه`, Persian digits, `٬`, `000`-padded refs) |

Errors consistently follow `{"code": "...", "message": "..."}`.

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
# (expects running Postgres, RabbitMQ, and hamtapay/t103-simulator:1.0 in SIM_CHAOS=hostile)
LIVE_SIMULATOR_E2E=true npm run test:e2e:hostile

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
