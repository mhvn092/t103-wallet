# Incident Postmortem Analysis (`02:10` AM Deployment)

## 1. Algebraic Root-Cause Proof & Most Likely Causes

The incident report gives two exact invariants across **17 users** (`4,210 USDT` total drift) within 10 minutes after the `02:10` deploy, as withdrawal pods scaled `2 → 6` and Redis CPU hit `100%`:
- Stored wallet balance $B < 0$, while the authoritative sum of double-entry ledger rows $L \ge 0$ is **correct**, and $B \neq L \implies B < L$.

This inequality mathematically eliminates two common failure modes:
- **Symmetric double-execution** drives *both* ledger and balance negative ($B = L < 0$).
- **Classic read-modify-write lost update** drops a subtraction and *inflates* stored balance ($B > L$).

$B < 0 \le L$ proves **asymmetric state mutation** between the mutable wallet balance update and the immutable ledger write:

1. **Cause A — Asymmetric Idempotency Under Redis Lock Timeout (Most Probable):** The `02:10` deploy spiked Redis CPU to `100%`. Redis-backed distributed locks expired or failed open mid-flight across `2 → 6` pods, causing concurrent retries of the same withdrawal (`>= 2` attempts/user). The ledger table had a DB unique constraint (`$L$` debited once), whereas a separate `UPDATE wallets SET balance = balance - amount` ran outside that idempotency boundary ($B$ debited twice, driving $B$ negative by `4,210 USDT`).
2. **Cause B — Uncompensated Balance Deduction / Stale Redis Balance Check:** Under `100%` Redis CPU, a second withdrawal read a stale cached balance (or bypassed a timed-out Redis lock) and decremented `wallets.balance` *before* a downstream failure rolled back the ledger write without compensating `wallets.balance`.

## 2. Evidence Needed to Confirm Each Cause

| Hypothesis | Required Data / Query | Expected Confirmation Signal |
| --- | --- | --- |
| **Cause A / B** | `SELECT user_id, balance, ledger_sum, (ledger_sum - balance) AS gap` joined to `02:00–02:10` `withdrawals` | `gap` equals exact multiples of specific `(amount + fee)` rows; total across 17 users = `4,210 USDT` |
| **External Loss?** | Payout API (`GET /payout/transfers/{requestId}`) + `TRC20` on-chain tx hashes | Confirms whether double payouts hit blockchain (`$4,210` real loss) vs. internal DB drift (`$0` external loss) |
| **Deploy & Redis** | Git diff of `02:10` release; Redis `SLOWLOG` / `INFO commandstats`; withdrawal pod logs | New Redis command/HPA change at `02:10`; lock-timeout warnings matching the 17 `user_id`s |

## 3. First 30 Minutes Action Plan

- **Min 0–5 (Contain):** Pause outbound `USDT` withdrawals, set `outbound_frozen = true` on all 17 affected `user_id`s to block further withdrawals or internal transfers, and page Incident Commander + Treasury.
- **Min 5–15 (Scope & Treasury Check):** Run the global `ledger_sum vs wallets.balance` audit across **every** account (confirm drift is bounded to these 17 users / `4,210 USDT`), and reconcile Payout logs + `TRC20` tx hashes to verify on-chain truth.
- **Min 15–30 (Stabilize & Remediate):** Roll back the `02:10` deploy, cap worker concurrency to restore Redis health, verify zero new drift on incoming traffic, and—only after Payout/on-chain truth is confirmed—prepare a peer-reviewed reconciliation patch (`OPS_ADJ` compensating ledger entry; never blind SQL balance edits).

## 4. Immunity of Our T-103 Architecture

Our design makes this entire class of failure **structurally impossible**:
1. **Zero Redis in Critical Path:** No Redis distributed locks or cached balances exist; all concurrency serializes inside PostgreSQL via `SELECT ... FOR UPDATE` and Statement-#1 `idempotency_keys`.
2. **Database-Materialized Balance ($B == L$ Enforced by Postgres):** `BEFORE UPDATE OF balance ON accounts` trigger guards (`pg_trigger_depth() <= 1` and session GUC `t103.allow_balance_update IS DISTINCT FROM 'on'`) **forbid direct SQL/ORM updates** to `accounts.balance`. Balances mutate *only* inside `BEFORE INSERT ON ledger_items` in the same ACID transaction as the balanced `ledger_transactions` commit.
3. **Universal DB Floor:** `CHECK ((owner_type = 'SYSTEM' AND balance IS NULL) OR (owner_type = 'USER' AND balance >= 0))` rejects any transaction that would drive any `USER` account negative, even under application bugs or `N` autoscaled pods.
