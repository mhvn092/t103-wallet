# T-103: Deliberate Ambiguities — Decisions, Implementation & Rationale

T-103 leaves three operational and financial edge cases intentionally open-ended. Below are our concrete decisions, exact implementations, and engineering trade-offs.

---

## Ambiguity #1 *(Mandatory)*: Late `SUCCEEDED` After Marking a Withdrawal `FAILED`

> **Prompt:** A withdrawal was marked `FAILED` after prolonged silence, and the user already withdrew the same funds again. Now Payout notifies us that the first withdrawal actually `SUCCEEDED`. What do we do, and which earlier decision should have been taken differently?

### 1. Which Earlier Decision Should Have Been Different (Root Prevention)
The critical earlier mistake is **inferring `FAILED` from silence, HTTP timeouts, `5xx` errors, or missed webhooks**. In external banking/blockchain systems, timeout means **"outcome unknown"**, never **"did not happen"**.

In our design:
- **Timeouts / `5xx` / Worker Crashes Never Auto-Fail:** Funds stay `LOCKED`, `WithdrawalWorker` continuously queries `GET /payout/transfers/{provider_request_id}` on `next_poll_at` schedules, and prolonged ambiguity past `WD_MANUAL_REVIEW_SLA_MS` escalates to **`MANUAL_REVIEW`** (keeping funds `LOCKED`).
- **Strict Terminal Transition Rule:** A withdrawal enters `FAILED` (releasing `LOCKED → AVAILABLE`) **only** on an explicit, verified provider rejection (recognized HTTP `400`/`422` validation code on initial submission or signed/polled terminal `FAILED`), cancellation while still `PENDING_DISPATCH`, or an explicit Operations override after offline bank confirmation.

### 2. Recovery Protocol If It Still Happens (`WD_LATE_SUCCESS`)
Even with strict rules, an external provider bug or premature Ops override could still produce a late `SUCCEEDED` on a `FAILED` withdrawal. When that arrives:
1. **Never break the `balance >= 0` invariant on `USER:AVAILABLE`:** A user liability wallet must never hold a negative `AVAILABLE` balance. Instead, we model customer debt explicitly using a `DEBIT`-normal Asset account: **`USER:{userId}:{currency}:RECEIVABLE`**.
2. **Atomic Clawback + Receivable Booking (Single DB Transaction):**
   - Pre-ensure `AVAILABLE`, `RECEIVABLE`, and `user_restrictions` outside TX, then lock `withdrawals`, `user_restrictions`, `USER:AVAILABLE`, and `USER:RECEIVABLE` in Canonical Lock Order.
   - Compute:
     - `owed = amount + fee`
     - `clawback = min(available, owed)`
     - `shortfall = owed - clawback >= 0`
   - Post an immutable compensating ledger transaction **`WD_LATE_SUCCESS`** (never deleting the prior `WD_RELEASE` history):
     - `DEBIT USER:AVAILABLE` by `clawback` *(if `> 0`; decreases available liability)*
     - `DEBIT USER:RECEIVABLE` by `shortfall` *(if `> 0`; increases `DEBIT`-normal debt Asset `>= 0`)*
     - `CREDIT SYSTEM:PAYOUT_CLEARING` by `amount`
     - `CREDIT SYSTEM:FEE_REVENUE` by `fee` *(if `> 0`)*
3. **Contain Further Drain (`outbound_frozen` + Triage Alert):**
   - Set `withdrawals.late_success_conflict = true`, `status = 'SUCCEEDED'`, and `quota_released = false` (atomically restoring `irt_equivalent` into `user_daily_limits` under Canonical Lock Order so same-day `200M` cap cannot be bypassed even when `shortfall = 0`).
   - Require authoritative `GET /payout/transfers/{provider_request_id}` verification before triggering `WD_LATE_SUCCESS` from a webhook, and block `WD_LATE_SUCCESS` whenever `terminal_return = true` (e.g., out-of-order `RETURNED -> SUCCEEDED` arrivals).
   - When `shortfall > 0`, set **`user_restrictions.outbound_frozen = true`**, blocking **both** `POST /withdrawals` and `POST /transfers` (`403 OUTBOUND_FROZEN`) so the user cannot drain funds while owing `RECEIVABLE`.
   - Create an `OPEN` **`LATE_SUCCESS_CONFLICT`** record in `financial_discrepancies` for Operations/Risk recovery.

---

## Ambiguity #2 *(Bonus)*: Daily `200M` Toman Cap for `USDT`, Failed Withdrawals & Day Boundary

> **Prompt:** At what FX rate is the `200M` Toman daily limit applied to `USDT` withdrawals? Does a failed withdrawal count against the limit? At what hour does a "day" start?

### 1. `USDT → IRT` Conversion Rate & Zero-Float Rounding
- **Combined Multi-Currency Cap:** `IRT` and `USDT` withdrawals share one unified `user_daily_limits(user_id, limit_date)` quota of `200,000,000` Toman (`IRT`) per user per day.
- **Rate Source & Snapshotting:** `USDT` converts at configurable `USDT_IRT_RATE` (integer Toman per `1 USDT`, env-configurable for T-103; in production sourced from internal orderbook mid-price / TWAP oracle with staleness bounds).
- **Exact Integer Ceiling Math:** Computed over principal `amount` using zero-float `bigint` ceiling division:
  `(amount_minor * fx_rate_irt + 999_999n) / 1_000_000n`
  *(Ceiling prevents fractional micro-USDT from sneaking past `200,000,000` IRT; both `fx_rate_irt` and `irt_equivalent` are snapshotted permanently onto the `withdrawals` row so later rate changes never shift historical quota.)*
- **Principal vs. Fee:** The `1 USDT` exchange fee is internal revenue (`SYSTEM:FEE_REVENUE`) rather than external capital outflow, so only principal `amount` counts toward the `200M` limit.

### 2. Failed, Cancelled & Returned Withdrawals
- **Reserved Up Front, Refunded on `FAILED`:** Quota is incremented atomically at `WD_HOLD` creation so `100` concurrent pending withdrawals cannot queue past `200M` Toman simultaneously.
- **Midnight-Safe Refund:** When a withdrawal transitions to `FAILED` (provider rejection, pre-dispatch cancel, or post-success `WD_RETURN`), `user_daily_limits` is decremented using the withdrawal's snapshotted **`wd.limit_date`** and **`wd.irt_equivalent`** (guarded by `quota_released = false → true`). A withdrawal submitted at `23:55` that fails at `00:05` cleanly refunds yesterday's row without corrupting today's `0` counter or violating `CHECK (used_irt_amount >= 0)`.

### 3. When Does a "Day" Start?
- **`00:00:00 Asia/Tehran` (`UTC+03:30`):** Matches Iranian banking/Paya settlement expectations. Iran abolished Daylight Saving Time permanently in 2022, leaving `Asia/Tehran` at a fixed `+03:30` offset year-round.

---

## Ambiguity #3 *(Bonus)*: User-Initiated Withdrawal Cancellation

> **Prompt:** If a user wants to cancel a submitted withdrawal, at which stages is cancellation allowed?

### Decision: Strictly **`PENDING_DISPATCH` Only**
- **Allowed (`PENDING_DISPATCH`):** Before `WithdrawalWorker` claims the row. The request supplies the owner ID and locks the matching withdrawal `FOR UPDATE` in `POST /withdrawals/:id/cancel`, then transitions to `FAILED` (`failure_reason = 'CANCELLED_BY_USER'`), posts `WD_RELEASE` (`LOCKED → AVAILABLE`), and refunds `user_daily_limits`.
- **Forbidden Stages (`409 INVALID_STATE_TRANSITION`) & Rationale:**
  - **`DISPATCHING`:** A worker holds an active lease and may already be transmitting to `POST /payout/transfers`. Cancelling here risks paying out externally *and* unlocking funds (double-spend).
  - **`PROCESSING` / `MANUAL_REVIEW`:** The transfer instruction is already at the bank/blockchain (`IBAN` or irreversible `TRC20`), where unilateral recall is unsafe or impossible.
  - **`SUCCEEDED` / `FAILED`:** Already terminal.
- **Deliberate Trade-Off:** We trade a tiny cancel window for fast async dispatch and zero double-payout risk.
