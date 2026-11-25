# T-103: 50x Scalability Analysis (`500` Withdrawals/sec, `2M` Wallets, `200` Hot-Wallet RPS)

**Scenario (T-103 Bonus Analysis):** Traffic scales `50×` to **`500` withdrawals/sec**, **`2,000,000` user wallets** (~6–8M rows in `accounts`), and **one corporate wallet submitting `200` withdrawals/sec** continuously. *(Analysis only; no implementation required.)*

**Simple Intuition:**
Scaling a ledger 50x does not mean splitting it into microservices—that actually makes row locking slower. Normal users (`300/s` across 2 million wallets) never collide with each other. The real wall is one hot corporate wallet hitting the exact same balance and daily-limit rows `200` times per second, followed by ledger table growth and slow outbound bank HTTP calls tying up API workers.

---

## 1. Architectural Premise: Why Modular Monolith Scales Better Than Microservices

**Simple Intuition:**
A single withdrawal needs to check the daily limit, check freezes, lock the balance, and write the ledger + outbox together. If you split those into separate microservices, one fast local DB transaction turns into slow network calls and distributed sagas—making hot accounts lock *longer* and fail partially. Keep one transactional boundary in a Modular Monolith and scale stateless app/worker pods around it.

**Technical Details:**
- **The Distributed Transaction Nightmare (`2PC` / Sagas):** Checking `user_daily_limits`, enforcing `outbound_frozen`, locking `AVAILABLE → LOCKED`, and writing balanced `ledger_items` + `outbox_events` currently takes **one ~2ms local PostgreSQL ACID transaction**. Splitting these across microservice boundaries turns one local lock into 4+ cross-network RPCs plus distributed `2PC` or Saga compensating transactions—multiplying tail latency (`P99`), lengthening lock hold times (which *reduces* max TPS on hot accounts), and introducing split-brain partial-failure windows.
- **Scalability Comes from Storage Partitioning & Lock Elimination, Not Network Boundaries:** Large-scale commerce and ledger platforms prove this in practice. **Shopify's core platform** handles massive Black Friday / Cyber Monday (BFCM) throughput as a **Modular Monolith**—scaling stateless compute horizontally and partitioning data rather than paying microservice RPC overhead inside ACID invariants.

Our **NestJS Modular Monolith** keeps strict module boundaries in code while running stateless `API` and `Worker` pods horizontally against one transactional boundary.

---

## 2. Capacity Math & Where the First Bottleneck Hits

**Simple Intuition:**
Because system accounts are never locked, normal retail traffic (`300 wd/s` spread across 2M users) scales effortlessly. The first hard bottleneck is the `200 wd/s` corporate wallet: one database row can only handle one exclusive transaction at a time (~5ms each, capping around `200 TPS`). After that, inserting ~200M ledger rows a day bloats indexes, and waiting on slow bank APIs inside API pods starves incoming user requests.

At **`500 wd/s`** across **`2,000,000` wallets**:
- **Distributed Retail Traffic (`300 wd/s` across `2M` wallets):** Already **not** a bottleneck. Because `SYSTEM` accounts (`PAYOUT_CLEARING`, `FEE_REVENUE`) keep `balance IS NULL` and are never locked or updated, retail withdrawals share zero row locks and represent `< 2,500` IOPS on NVMe PostgreSQL.

### Bottleneck #1 (Immediate Wall): Single-Row `FOR UPDATE` Serialization on the Corporate Hot Wallet (`200 wd/s`)
Our current Canonical Lock Order serializes every withdrawal for `corp_user` on **two** hot rows:
1. `user_daily_limits('corp_user', today)`
2. `accounts('USER', 'corp_user', ccy, 'AVAILABLE')`

**The Queueing Math:** Even with fast NVMe WAL writes, a single PostgreSQL `READ COMMITTED` transaction holding an exclusive row lock takes **`~3–5ms`**. By Little's Law, the theoretical ceiling on one serialized row is:

$$\text{Max Single-Row TPS} = \frac{1000\text{ ms}}{5\text{ ms/tx}} \approx 200\text{ TPS}$$

At `200 wd/s` sustained (and bursts above `200/s`), `corp_user` sits at **100% row-lock saturation**: wait queues grow unboundedly, `P99` spikes to seconds, and `POST /withdrawals` exhausts the Node.js DB connection pool—degrading retail users via noisy-neighbor pool starvation.

### Bottleneck #2 (Storage & Index Bloat): `ledger_items` Growth
- `500 wd/s` × `2` transactions (`WD_HOLD` + `WD_SETTLE`) × `2–3` items ≈ **`2,200–2,500` `ledger_items` inserts/sec** (`~200M+` rows/day, ~40 GB/day with indexes).
- Without partitioning, `(user_id, account_type, id DESC)` B-tree indexes exceed shared buffers, causing random disk reads, slower `AUTOVACUUM`, and rising transaction-ID wraparound risk.

### Bottleneck #3 (Egress Worker Saturation): Outbound Payout HTTP Latency
- At `500 wd/s`, if `POST /payout/transfers` averages `200ms–1,000ms` (or spikes under bank degradation), `WithdrawalWorker` needs **`100–500+` concurrent outbound HTTP requests**. Running workers inside API pods shares the event loop and DB pool with user HTTP traffic.

---

## 3. Phase 1 Evolution: Scaling on PostgreSQL (`500` → `5,000+ wd/s`)

**Simple Intuition:**
You can push PostgreSQL to `5,000+ wd/s` without changing engines: (1) batch or shard the hot corporate wallet so it stops acquiring a fresh row lock per request, (2) range-partition the ledger tables so active indexes stay in RAM, put PgBouncer in front, and send reads to replicas, and (3) run API servers and outbound payout workers in separate pods so slow banks never stall user HTTP traffic.

### 3A. Breaking the `200 wd/s` Corporate Hot-Row Wall
1. **Per-Wallet Group-Commit Micro-Batching *(Primary Recommendation)*:**
   - Route high-throughput corporate accounts (`corp_user`) through a partitioned coalescer with a **`5–10ms` batch window** (2–10 requests per DB transaction).
   - One DB transaction acquires the `FOR UPDATE` lock on `corp_user` **once**, validates total batch sum, inserts `N` `withdrawals`, and commits atomically—cutting row-lock stalls by **`5×–20×`** (`2,000–4,000+ wd/s`).
2. **Virtual Sub-Bucket Sharding *(Stateless Multi-Pod Alternative)*:**
   - Shard hot accounts into `K = 16` virtual `AVAILABLE#0..15` sub-accounts **and** `16` `user_daily_limits` buckets (`sharding accounts alone still blocks on the single daily-limit row`), sweeping in deterministic `id ASC` order when borrowing across shards.

### 3B. Storage Partitioning, Pooling & Read/Write Separation
- **Declarative Range Partitioning:** Partition `ledger_items` by monotonic `id` ranges (50M rows/partition) and `ledger_transactions`/`withdrawals` by `UUIDv7` time ranges so hot indexes stay resident in RAM.
- **Connection Multiplexing:** Place **PgBouncer** (transaction pooling) in front of PostgreSQL with isolated corporate vs. retail connection pools.
- **Read Replicas:** Route `GET /wallets/:userId/ledger`, `GET /wallets/:userId`, and `/reconciliation/run` to read replicas.

### 3C. Split Runtime Modes (`ROLE=api` vs. `ROLE=worker`)
- Run identical codebase pods independently: `api` pods serve REST/webhooks; `worker` pods autoscale on `PENDING_DISPATCH` / `outbox_events` backlog with `SKIP LOCKED`.

---

## 4. Phase 2 Evolution: Offloading the Hot Ledger to **TigerBeetle** (`10,000` → `1,000,000 TPS`)

**Simple Intuition:**
If volume ever explodes past what PostgreSQL row locks can absorb (`10,000+ TPS`), move the hot balance and double-entry postings into **TigerBeetle** (a purpose-built financial ledger engine that already supports non-negative balances and two-phase holds natively), while keeping PostgreSQL as the workflow and history database—using the same `UUIDv7` IDs so retries stay idempotent without `2PC`.

**Technical Details:**
If exchange volume reaches `10,000+ TPS`, offload real-time balance & double-entry postings to **TigerBeetle** (`io_uring` + VSR consensus, native `debits_must_not_exceed_credits`, native two-phase `pending` holds matching `WD_HOLD`/`WD_SETTLE`/`WD_RELEASE`), while **PostgreSQL stays the Control Plane** (`idempotency_keys`, IBAN/TRC20 validation, withdrawal state machine, `outbox_events`, ledger history read model). Because TigerBeetle uses deterministic `u128` idempotent `Transfer.id`s matching Postgres `UUIDv7` keys, crash recovery retries with the identical `u128` ID (`EXISTS` idempotency) with **zero distributed `2PC`**.
