-- 1. Drop unused or non-selective indexes to reduce write amplification and bloat
DROP INDEX IF EXISTS "ledger_items_account_cursor_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "deposits_psp_ref_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "transfers_from_user_created_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "financial_discrepancies_user_status_idx";
--> statement-breakpoint

-- 2. Upgrade active hot-path indexes to covering indexes (INCLUDE), keeping mutable accounts.balance out of INCLUDE to preserve HOT updates
DROP INDEX IF EXISTS "accounts_owner_currency_type_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_owner_currency_type_uq" ON "accounts" USING btree ("owner_type","owner_id","currency","account_type") INCLUDE ("id");
--> statement-breakpoint
DROP INDEX IF EXISTS "ledger_items_tx_idx";
--> statement-breakpoint
CREATE INDEX "ledger_items_tx_idx" ON "ledger_items" USING btree ("transaction_id") INCLUDE ("currency","direction","amount");
--> statement-breakpoint
DROP INDEX IF EXISTS "ledger_items_user_cursor_idx";
--> statement-breakpoint
CREATE INDEX "ledger_items_user_cursor_idx" ON "ledger_items" USING btree ("user_id","account_type","id" DESC NULLS LAST) INCLUDE ("transaction_id","currency","direction","amount","balance_after") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "ledger_tx_ref_type_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_tx_ref_type_uq" ON "ledger_transactions" USING btree ("reference_type","reference_id","type") INCLUDE ("id");
--> statement-breakpoint
DROP INDEX IF EXISTS "deposits_verified_at_idx";
--> statement-breakpoint
CREATE INDEX "deposits_verified_at_idx" ON "deposits" USING btree ("verified_at") INCLUDE ("id","psp_ref_id","verified_amount") WHERE "status" = 'SUCCEEDED';
--> statement-breakpoint
DROP INDEX IF EXISTS "deposits_poll_idx";
--> statement-breakpoint
CREATE INDEX "deposits_poll_idx" ON "deposits" USING btree ("next_poll_at") INCLUDE ("id") WHERE ("status" <> 'SUCCEEDED' AND "next_poll_at" IS NOT NULL);
--> statement-breakpoint
DROP INDEX IF EXISTS "withdrawals_dispatch_idx";
--> statement-breakpoint
CREATE INDEX "withdrawals_dispatch_idx" ON "withdrawals" USING btree ("created_at") INCLUDE ("status","lease_until") WHERE "status" IN ('PENDING_DISPATCH', 'DISPATCHING');
--> statement-breakpoint
DROP INDEX IF EXISTS "outbox_pending_idx";
--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("next_retry_at") INCLUDE ("lease_until","created_at") WHERE "status" = 'PENDING';
--> statement-breakpoint

-- 3. Add targeted partial/retention indexes matching actual metrics & RetentionWorker predicates
CREATE INDEX IF NOT EXISTS "financial_discrepancies_open_idx" ON "financial_discrepancies" USING btree ("id") WHERE "status" = 'OPEN';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_manual_review_idx" ON "withdrawals" USING btree ("id") WHERE "status" = 'MANUAL_REVIEW';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_published_retention_idx" ON "outbox_events" USING btree ("published_at") WHERE "status" = 'PUBLISHED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "processed_events_processed_at_idx" ON "processed_events" USING btree ("processed_at");
