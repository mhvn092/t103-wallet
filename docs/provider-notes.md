# External Simulator Discovery & Provider Notes (`hamtapay/t103-simulator:1.0`)

**Probed Image:** `hamtapay/t103-simulator:1.0` | **Modes Tested:** `SIM_CHAOS=default` & `SIM_CHAOS=hostile` (`SIM_TIME_SCALE=10` and `20`)  
**Method:** Strictly black-box HTTP probes + raw local webhook capture server (`X-Signature` HMAC-SHA256 verified against exact raw body bytes).

**Simple Intuition:**
External payment gateways and bank payout providers don't behave cleanly: they mix currencies, lie or fail ambiguously under load, send duplicate or out-of-order webhooks, spoof signatures in hostile tests, and export messy Persian spreadsheets. Instead of guessing how the simulator works, we probed it directly in both normal and hostile modes and built defensive guardrails around every real quirk we observed.

---

## 1. Critical Empirical Discoveries & Design Changes

### Finding #1 — PSP Currency Unit Is **Rial (`IRR`)**, Not Toman (`IRT`) *(Critical)*

**Simple Intuition:**
Our wallet speaks Toman (`IRT`), while both the PSP and Payout APIs expect Rials (`IRR`, 10x Toman). Keep all internal accounting in Tomans and convert `× 10` / `÷ 10` strictly at the provider HTTP boundary (flagging any non-multiple-of-10 response as a discrepancy).

- **Observation:** Calling `POST /psp/payments` with `amount: 150000` causes `GET /psp/pay/{token}` to display:
  ```json
  {
    "token": "A0798e864e92ce60fe",
    "merchant": "Hamta Exchange (sandbox)",
    "amount": "150000",
    "display": "مبلغ قابل پرداخت: ۱۵٬۰۰۰ تومان",
    "status": "INIT"
  }
  ```
- **Impact:** Both PSP (`amount` in `/psp/payments`, `/psp/verify`, `/psp/payments/{token}`, and `/psp/settlement` CSV) **and** Payout (`currency: "IRR"`) operate in **Rials (`IRR`)**, whereas our Wallet API speaks **Tomans (`IRT`)**.
- **Design Change (`design.md v1.1`):** `PspClient` converts `IRT × 10n → IRR` on `POST /psp/payments` and `IRR ÷ 10n → IRT` when verifying/reconciling (recording `financial_discrepancies` if a hostile response ever returns a non-multiple of `10`).

---

### Finding #2 — `POST /psp/verify` Returns `status: "FAILED" (code: -51)` on **Unpaid `INIT`** Deposits!

**Simple Intuition:**
Never call `/psp/verify` blindly on a deposit that hasn't been paid yet, because the PSP responds with the exact same `FAILED` code as a genuinely failed payment. Check `GET /psp/payments/{token}` first, treat `503` errors as transient retries, and only fail a deposit if the PSP explicitly reports `FAILED` or its expiry window passes.

- **Observation (`default` mode):**
  - On a freshly paid token (`POST /psp/pay/{token}` `{"result":"success"}`):
    ```json
    // 1st POST /psp/verify -> 200
    { "code": 100, "status": "OK", "amount": "150000", "refId": "4667906176" }

    // 2nd POST /psp/verify -> 200
    { "code": 101, "status": "ALREADY_VERIFIED", "amount": "150000", "refId": "4667906176" }

    // GET /psp/payments/{token} -> 200
    { "token": "A0798e864e92ce60fe", "orderId": "...", "status": "VERIFIED", "amount": "150000", "refId": "4667906176" }
    ```
  - On an **unpaid** token (`GET /psp/payments/{token}` still shows `"status": "INIT"`):
    ```json
    // POST /psp/verify -> 200 (DANGER: looks identical to a failed payment!)
    { "code": -51, "status": "FAILED", "message": "payment not successful" }
    ```
  - In `SIM_CHAOS=hostile`, `POST /psp/verify` intermittently returns `503`:
    ```json
    { "code": -1, "message": "service unavailable" }
    ```
    even while `GET /psp/payments/{token}` already shows `status: "PAID"`, `refId: "7185146789"`.
- **Design Change (`design.md v1.1`):**
  1. Never call `/psp/verify` blindly before checking `GET /psp/payments/{token}` (or receiving an `OK` callback)! Calling `/psp/verify` while `INIT` falsely reports `code: -51 / FAILED` and could kill an active user payment.
  2. Treat **both** `code: 100 / status: "OK"` and `code: 101 / status: "ALREADY_VERIFIED"` as verified success (all `amount` values arrive as **strings**).
  3. Treat `503 { code: -1 }` as transient (`VERIFYING`, exponential backoff retry). Mark `FAILED` only when `GET /psp/payments/{token}` explicitly says `FAILED` or remains `INIT` past `expires_at` (`30m`).

---

### Finding #3 — `POST /psp/payments` `orderId` Is **Not** Idempotent on Simulator

**Simple Intuition:**
Calling `POST /psp/payments` twice with the same `orderId` creates two different payment tokens on the PSP side. So save the returned token to our database before returning `201`, and if an attempt crashes before saving a token, just let that unused `INITIATED` row expire safely rather than blindly creating a second token.

- **Observation:** Two `POST /psp/payments` calls with identical `orderId: "probe-dup-ord-..."` returned `201` with **two different tokens** (`A064c620396ecacf32` and `A0d69acfdcf6ec9c2b`).
- **Design Change (`design.md v1.1`):** `POST /deposits` persists `psp_token` before returning `201`. An orphaned `INITIATED` row (`psp_token IS NULL`) past its 60s lease was never exposed to a user and expires safely to `FAILED` without re-calling `POST /psp/payments`.

---

### Finding #4 — Payout `503` & Socket Resets Can Still `SUCCEED` After Returning `404`! *(Critical)*

**Simple Intuition:**
In hostile mode, an outbound payout can return `503` or drop the socket, then return `404 NOT_FOUND` on an immediate status check, and *still* succeed a second later. So never mark a payout failed on network errors, `503`s, or `404`s—instead, check `GET`, and if it's still `404`, safely retry `POST` using the exact same `provider_request_id` so the provider's own idempotency deduplicates it.

- **Observation (`SIM_CHAOS=hostile`, `SIM_TIME_SCALE=20`):**
  - `POST /payout/transfers` (`requestId: "h2-wd-...-15"`) failed client-side with **`TypeError: fetch failed`**. Immediate `GET /payout/transfers/{requestId}` returned **`404 { "error": "NOT_FOUND" }`** — and **~1.5s later flipped to `200 { "status": "SUCCEEDED" }`**!
  - `POST /payout/transfers` (`requestId: "h2-wd-...-17"`) returned **`503 { "error": "UPSTREAM_UNAVAILABLE" }`**. Immediate `GET /payout/transfers/{requestId}` returned **`404 NOT_FOUND`** — and **later flipped to `200 SUCCEEDED`**!
  - `POST /payout/transfers` (`requestId: "h2-wd-...-6"`) returned `503`, then later delivered a webhook for that `requestId` (`TRKad307fbb6e80d46c`)!
  - `POST /payout/transfers` returns **`202`** (`status: "ACCEPTED"`, `trackingId: "TRK..."`) on first submit, **`200`** (`status: "ACCEPTED"`) on idempotent duplicate `requestId`, and **`400 { "error": "INVALID_REQUEST_ID" }`** if `requestId` is invalid—**while invalid IBANs are accepted with `202`** and fail later asynchronously (`status: "FAILED", reason: "INVALID_IBAN"`).
- **Design Change (`design.md v1.1`):**
  1. **Never fail a withdrawal** on `503`, network reset, timeout, OR even a subsequent `404` from `GET /payout/transfers/{requestId}`!
  2. On recovery, if `GET` returns `404`, `WithdrawalDispatcher` re-POSTs with the **exact same `provider_request_id`** (hitting Payout's `200 ACCEPTED` idempotency if the earlier `503`/reset had actually been queued upstream).

---

### Finding #5 — Out-of-Order Stale Webhooks & Spoofed Invalid-HMAC `FAILED` Webhooks

**Simple Intuition:**
Webhooks arrive late, duplicated, out of order, and sometimes forged. Always verify the HMAC signature on raw bytes before parsing or trusting anything, and only allow withdrawal states to move forward so a late `PROCESSING` webhook can never roll back a `SUCCEEDED` payout.

- **Observation:**
  - **Raw Payout Webhook Format (`default` & `hostile`):**
    ```text
    POST /webhooks/payout
    x-signature: 715b783c8e076b60f82dd82111450a2a49b4636a10cc8cc01eb46214bb19815b
    x-event-id: evt_9825c4d836b11fd8
    Body: {"event":"transfer.updated","eventId":"evt_9825c4d836b11fd8","requestId":"probe-irr-1795512490938","trackingId":"TRK2aa1a34ecd0b54c1","status":"SUCCEEDED","reason":null,"amount":"3000000","currency":"IRR","occurredAt":"2026-11-24T09:28:13.750Z"}
    ```
  - **Duplicate & Out-of-Order (`default` & `hostile`):** After delivering `SUCCEEDED` (`09:28:13.751Z`), the simulator delivered a duplicate `SUCCEEDED` (`09:28:14.117Z`), then **two stale `PROCESSING` webhooks (`occurredAt: 09:28:11.020Z`) at `09:28:14.131Z` and `09:28:14.521Z`**!
  - **Spoofed `FAILED` Webhooks (`hostile`):** Delivered forged `status: "FAILED"` webhooks with non-matching `x-signature` right after `SUCCEEDED`:
    ```text
    x-signature: e6dfe45e8663d7f90cc929cb3b4692a3709a77605aa5964396ad6db7221dd458 (INVALID)
    Body: {"event":"transfer.updated","eventId":"evt_4e6e2442d901bf9d","requestId":"hostile-wd-1795512544020-3","trackingId":"TRKa21bd06a078d5200","status":"FAILED","amount":"12.5","currency":"USDT","occurredAt":"2026-11-24T09:29:06.717Z"}
    ```
  - **PSP Callbacks (`callbackUrl`):** Unsigned (`no x-signature`), duplicated up to 3× in `hostile`, body: `{"token":"...","orderId":"...","status":"OK"|"NOK"}`.
- **Design Change (`design.md v1.1`):**
  1. Verify `X-Signature` (lowercase 64-char hex HMAC-SHA256 over raw bytes, length-checked before `timingSafeEqual`) → immediately reject `401` on invalid signatures.
  2. Enforce strictly forward-only withdrawal state transitions (ignoring stale `PROCESSING` webhooks once terminal `SUCCEEDED`/`FAILED`).

---

### Finding #6 — Settlement CSV Format & Dirty Data (`GET /psp/settlement?date=YYYY-MM-DD`)

**Simple Intuition:**
The PSP settlement CSV is a messy real-world Persian bank export: Persian digits and separators, zero-padded reference IDs, duplicate rows, and mixed transaction types (deposits, payouts, fees, and unknown payments). Clean and normalize the fields first, deduplicate repeated rows, filter to deposit lines (`واریز درگاه`), convert Rials to Tomans, and then reconcile against our database.

- **Observation (`SIM_CHAOS=hostile` sample):**
  ```csv
  ردیف,تاریخ,شماره پیگیری,نوع تراکنش,مبلغ (ریال),شرح
  1,۱۴۰۵/۰۹/۰۳,0001382264189,واریز درگاه,"۵۰۰٬۰۰۰",پرداخت اینترنتی A0e446df4620bb6a73
  2,1405/09/03, 4929073756 ,واریز درگاه,"510,000",پرداخت اینترنتی A00a6998e75ec01778
  3,1405/09/03,4619725313,واریز درگاه,"۵۲۰٬۰۰۰",پرداخت اینترنتی A004204f35e048b3db
  3,1405/09/03,4619725313,واریز درگاه,"۵۲۰٬۰۰۰",پرداخت اینترنتی A004204f35e048b3db
  8,1405/09/03, TRK0a29ff53fa92a12e ,برداشت پایا,"-1,500,000",انتقال به IR062960000000100324200001
  9,۱۴۰۵/۰۹/۰۳,TRK0a29ff53fa92a12e,کارمزد,"-۲٬۵۰۰",کارمزد انتقال پایا
  10,1405/09/03,000TRK22937df565d811f0,برداشت پایا,"-1,500,000",انتقال به IR062960000000100324200001
  16,1405/09/03,0006944051731,واریز درگاه,"3,100,000",پرداخت اینترنتی نامشخص
  ```
- **6 Normalization Rules Required in `ReconciliationModule`:**
  1. **Persian CSV headers & CRLF (`\r\n`)** with quoted comma-containing fields (`"۵۰۰٬۰۰۰"`).
  2. **Mixed Persian (`۰-۹`) & ASCII digits** + **Persian thousands separator (`٬` U+066C)** + ASCII commas (`,`).
  3. **Unit is `ریال` (`IRR`):** divide parsed integer by `10n` to compare with `IRT` `deposits.verified_amount` (flagging mismatch if non-multiple of `10`).
  4. **Dirty `شماره پیگیری` (`refId`):** trim surrounding spaces and strip leading `0`s (`"0001382264189"` → `"1382264189"`, `"000TRK..."` → `"TRK..."`).
  5. **Duplicate rows** (`ردیف 3`, `8`, `13` appear twice identically) — deduplicate identical `(normalizedRef, txType, amountIrr)` rows before reconciling!
  6. **Multiple transaction types:** CSV contains `واریز درگاه` (deposits), `برداشت پایا` (bank payouts), and `کارمزد` (`-۲٬۵۰۰` bank fees sharing the same `TRK...` ref!) plus orphan `پرداخت اینترنتی نامشخص` rows. Reconcile `واریز درگاه` against local `deposits` (`SUCCEEDED`) and ignore `کارمزد` / filter by `نوع تراکنش = 'واریز درگاه'`.
