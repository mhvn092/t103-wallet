# Incident Postmortem Analysis (`02:10` AM Deployment)

Each section below opens with the **simple intuition** of what happened and what to do, followed by the exact algebraic proof, investigation queries, and architectural safeguards.

---

## 1. Root-Cause Intuition & Algebraic Proof

**Simple Intuition:**
The numbers themselves tell us what broke. If a retry simply executed a withdrawal twice end-to-end, *both* the wallet balance and the ledger would be wrong by the exact same amount. Instead, the ledger total is still valid (`>= 0`) while the wallet balance went negative (`< 0`). That proves the two updated out of sync: the balance column got subtracted twice, while the ledger only recorded the subtraction once. Almost certainly, the `02:10` deploy spiked Redis CPU to `100%`, causing Redis distributed locks to time out or cached balances to go stale across scaled pods—so two requests both subtracted the `wallets.balance` column, while a unique constraint on the ledger blocked the second ledger write.

**Algebraic Proof & Most Likely Causes:**
The incident report gives two exact invariants across **17 users** (`4,210 USDT` total drift) within 10 minutes after the `02:10` deploy, as withdrawal pods scaled `2 → 6` and Redis CPU hit `100%`:
- Stored wallet balance $B < 0$, while the authoritative sum of double-entry ledger rows $L \ge 0$ is **correct**, and $B \neq L \implies B < L$.

This inequality mathematically eliminates two common failure modes:
- **Symmetric double-execution** drives *both* ledger and balance negative ($B = L < 0$).
- **Classic read-modify-write lost update** drops a subtraction and *inflates* stored balance ($B > L$).

$B < 0 \le L$ proves **asymmetric state mutation** between the mutable wallet balance update and the immutable ledger write:

1. **Cause A — Asymmetric Idempotency Under Redis Lock Timeout (Most Probable):** The `02:10` deploy spiked Redis CPU to `100%`. Redis-backed distributed locks expired or failed open mid-flight across `2 → 6` pods, causing concurrent retries of the same withdrawal (`>= 2` attempts/user). The ledger table had a DB unique constraint (`$L$` debited once), whereas a separate `UPDATE wallets SET balance = balance - amount` ran outside that idempotency boundary ($B$ debited twice, driving $B$ negative by `4,210 USDT`).
2. **Cause B — Uncompensated Balance Deduction / Stale Redis Balance Check:** Under `100%` Redis CPU, a second withdrawal read a stale cached balance (or bypassed a timed-out Redis lock) and decremented `wallets.balance` *before* a downstream failure rolled back the ledger write without compensating `wallets.balance`.

---

## 2. Evidence Needed to Confirm Each Cause

**Simple Intuition:**
Before touching any balances, confirm three things: (1) which exact users and rows drifted, (2) whether real money actually left the exchange twice on-chain/at the payout provider or if this is purely an internal database mismatch, and (3) what changed in the `02:10` release that blew up Redis.

| Hypothesis | Required Data / Query | Expected Confirmation Signal |
| --- | --- | --- |
| **Cause A / B** | `SELECT user_id, balance, ledger_sum, (ledger_sum - balance) AS gap` joined to `02:00–02:10` `withdrawals` | `gap` equals exact multiples of specific `(amount + fee)` rows; total across 17 users = `4,210 USDT` |
| **External Loss?** | Payout API (`GET /payout/transfers/{requestId}`) + `TRC20` on-chain tx hashes | Confirms whether double payouts hit blockchain (`$4,210` real loss) vs. internal DB drift (`$0` external loss) |
| **Deploy & Redis** | Git diff of `02:10` release; Redis `SLOWLOG` / `INFO commandstats`; withdrawal pod logs | New Redis command/HPA change at `02:10`; lock-timeout warnings matching the 17 `user_id`s |

---

## 3. First 30 Minutes Action Plan

**Simple Intuition:**
Stop the bleeding first (pause USDT withdrawals and freeze the 17 affected accounts so no one can drain more funds), measure the true damage against external payout/blockchain records, and then roll back the bad deploy and repair the balances cleanly through compensating ledger entries—never by hand-editing the `balance` column.

- **Min 0–5 (Contain):** Pause outbound `USDT` withdrawals, set `outbound_frozen = true` on all 17 affected `user_id`s to block further withdrawals or internal transfers, and page Incident Commander + Treasury.
- **Min 5–15 (Scope & Treasury Check):** Run the global `ledger_sum vs wallets.balance` audit across **every** account (confirm drift is bounded to these 17 users / `4,210 USDT`), and reconcile Payout logs + `TRC20` tx hashes to verify on-chain truth.
- **Min 15–30 (Stabilize & Remediate):** Roll back the `02:10` deploy, cap worker concurrency to restore Redis health, verify zero new drift on incoming traffic, and—only after Payout/on-chain truth is confirmed—prepare a peer-reviewed reconciliation patch (`OPS_ADJ` compensating ledger entry; never blind SQL balance edits).

---

## 4. Immunity of Our T-103 Architecture

**Simple Intuition:**
This entire incident cannot happen in our design for a straightforward reason: we don't use Redis locks or separate balance updates at all. PostgreSQL is the only source of truth—balances are updated automatically inside the database only when balanced ledger items are inserted, and the database itself rejects any negative user balance.

**Technical Guarantees:**
1. **Zero Redis in Critical Path:** No Redis distributed locks or cached balances exist; all concurrency serializes inside PostgreSQL via `SELECT ... FOR UPDATE` and Statement-#1 `idempotency_keys`.
2. **Database-Materialized Balance ($B == L$ Enforced by Postgres):**
   - `BEFORE UPDATE OF balance ON accounts` triggers (`pg_trigger_depth() <= 1`) **forbid direct SQL/ORM updates** to `accounts.balance`.
   - `BEFORE INSERT OR UPDATE OF owner_type, owner_id, currency, account_type, normal_side ON accounts` (`trg_accounts_immutable_meta`) rejects non-zero `USER` account inserts and blocks `normal_side` / ownership tampering, paired with `accounts_type_normal_side_chk` and `BEFORE TRUNCATE` triggers on `ledger_transactions` and `ledger_items`.
   - Balances mutate *only* inside `BEFORE INSERT ON ledger_items` in the same ACID transaction as `ledger_transactions` (`tx_xid = pg_current_xact_id()`), while `LedgerService` enforces per-currency `SUM(DEBIT) = SUM(CREDIT)` before writing.
3. **Universal DB Floor:** `CHECK ((owner_type = 'SYSTEM' AND balance IS NULL) OR (owner_type = 'USER' AND balance >= 0))` rejects any transaction that would drive any `USER` account negative, even under application bugs or `N` autoscaled pods.
4. **Safe `2 -> N` Replica Scale-Out, Containment & Automated Circuit Breaker:** Startup migrations serialize on `pg_advisory_lock(840103)` so concurrent Kubernetes replicas never race on DDL; `POST /internal/controls/withdrawals-pause` pauses outbound `USDT` or `IRT` withdrawals at runtime without pod restarts; `DriftAuditWorker` automatically trips `withdrawals-pause` if `balanceDriftAccounts > 0`; `POST /internal/withdrawals/:id/resolve` closes `MANUAL_REVIEW` backlogs; and `GET /internal/metrics` + `GET /internal/metrics/prometheus` expose live discrepancy, `MANUAL_REVIEW`, outbox lag, pause state, and balance-drift telemetry.
