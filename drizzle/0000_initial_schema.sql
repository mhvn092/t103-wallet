-- 1. PostgreSQL ENUM types for all static domain values
CREATE TYPE "account_owner_type" AS ENUM ('USER', 'SYSTEM');
--> statement-breakpoint
CREATE TYPE "currency" AS ENUM ('IRT', 'USDT');
--> statement-breakpoint
CREATE TYPE "account_type" AS ENUM ('AVAILABLE', 'LOCKED', 'RECEIVABLE', 'CLEARING', 'ADJUSTMENT', 'REVENUE');
--> statement-breakpoint
CREATE TYPE "ledger_direction" AS ENUM ('DEBIT', 'CREDIT');
--> statement-breakpoint
CREATE TYPE "ledger_tx_type" AS ENUM ('DEPOSIT', 'WD_HOLD', 'WD_SETTLE', 'WD_RELEASE', 'WD_RETURN', 'WD_LATE_SUCCESS', 'OPS_ADJ', 'RECEIVABLE_SETTLE', 'TRANSFER');
--> statement-breakpoint
CREATE TYPE "ledger_ref_type" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT', 'TRANSFER');
--> statement-breakpoint
CREATE TYPE "idempotency_status" AS ENUM ('IN_PROGRESS', 'COMPLETED');
--> statement-breakpoint
CREATE TYPE "deposit_status" AS ENUM ('INITIATED', 'AWAITING_PAYMENT', 'VERIFYING', 'SUCCEEDED', 'FAILED');
--> statement-breakpoint
CREATE TYPE "withdrawal_status" AS ENUM ('PENDING_DISPATCH', 'DISPATCHING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'MANUAL_REVIEW');
--> statement-breakpoint
CREATE TYPE "discrepancy_ref_type" AS ENUM ('DEPOSIT', 'WITHDRAWAL');
--> statement-breakpoint
CREATE TYPE "discrepancy_type" AS ENUM (
	'AMOUNT_MISMATCH',
	'ORDER_ID_MISMATCH',
	'VERIFIED_AMOUNT_OUT_OF_RANGE',
	'DEPOSIT_OVERPAYMENT',
	'PSP_REFERENCE_REUSED',
	'PAYOUT_PAYLOAD_MISMATCH',
	'LATE_SUCCESS_VERIFICATION',
	'LATE_SUCCESS_CONFLICT'
);
--> statement-breakpoint
CREATE TYPE "discrepancy_status" AS ENUM ('OPEN', 'RESOLVED');
--> statement-breakpoint
CREATE TYPE "outbox_event_type" AS ENUM ('BALANCE_CHANGED');
--> statement-breakpoint
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PUBLISHED');
--> statement-breakpoint

-- 2. Core tables
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_type" "account_owner_type" NOT NULL,
	"owner_id" text NOT NULL,
	"currency" "currency" NOT NULL,
	"account_type" "account_type" NOT NULL,
	"normal_side" "ledger_direction" NOT NULL,
	"balance" numeric(38, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_owner_balance_chk" CHECK (("owner_type" = 'SYSTEM' AND "balance" IS NULL) OR ("owner_type" = 'USER' AND "balance" >= 0)),
	CONSTRAINT "accounts_type_normal_side_chk" CHECK (
		("owner_type" = 'USER' AND (
			("account_type" IN ('AVAILABLE', 'LOCKED') AND "normal_side" = 'CREDIT')
			OR ("account_type" = 'RECEIVABLE' AND "normal_side" = 'DEBIT')
		))
		OR ("owner_type" = 'SYSTEM' AND (
			("account_type" IN ('CLEARING', 'ADJUSTMENT') AND "normal_side" = 'DEBIT')
			OR ("account_type" = 'REVENUE' AND "normal_side" = 'CREDIT')
		))
	)
);
--> statement-breakpoint
CREATE TABLE "user_daily_limits" (
	"user_id" text NOT NULL,
	"limit_date" date NOT NULL,
	"used_irt_amount" numeric(38, 0) DEFAULT '0' NOT NULL,
	CONSTRAINT "user_daily_limits_user_id_limit_date_pk" PRIMARY KEY("user_id","limit_date"),
	CONSTRAINT "user_daily_limits_nonneg_chk" CHECK ("used_irt_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_restrictions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"outbound_frozen" boolean DEFAULT false NOT NULL,
	"freeze_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tx_xid" xid8 NOT NULL DEFAULT pg_current_xact_id(),
	"type" "ledger_tx_type" NOT NULL,
	"reference_type" "ledger_ref_type" NOT NULL,
	"reference_id" uuid NOT NULL,
	"description" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" text,
	"account_type" "account_type" NOT NULL,
	"currency" "currency" NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"balance_after" numeric(38, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_items_amount_pos_chk" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"currency" "currency" NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"reason" text NOT NULL,
	"operator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjustments_amount_pos_chk" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"requested_amount" numeric(38, 0) NOT NULL,
	"verified_amount" numeric(38, 0),
	"amount_mismatch" boolean DEFAULT false NOT NULL,
	"order_id" text NOT NULL,
	"psp_token" text,
	"psp_ref_id" text,
	"payment_url" text,
	"status" "deposit_status" NOT NULL,
	"expires_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"reconciled_settlement_date" date,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposits_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "deposits_psp_token_unique" UNIQUE("psp_token"),
	CONSTRAINT "deposits_requested_pos_chk" CHECK ("requested_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "financial_discrepancies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference_type" "discrepancy_ref_type" NOT NULL,
	"reference_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"discrepancy_type" "discrepancy_type" NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"currency" "currency" NOT NULL,
	"provider_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "discrepancy_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"locked_until" timestamp with time zone,
	"lease_version" bigint DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" "outbox_event_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"lease_until" timestamp with time zone,
	"next_retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"event_id" uuid NOT NULL,
	"consumer_name" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_event_id_consumer_name_pk" PRIMARY KEY("event_id","consumer_name")
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"currency" "currency" NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_amount_pos_chk" CHECK ("amount" > 0 AND "from_user_id" <> "to_user_id")
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"currency" "currency" NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"fee" numeric(38, 0) NOT NULL,
	"fx_rate_irt" numeric(38, 0) NOT NULL,
	"irt_equivalent" numeric(38, 0) NOT NULL,
	"limit_date" date NOT NULL,
	"quota_released" boolean DEFAULT false NOT NULL,
	"destination" text NOT NULL,
	"provider_request_id" varchar(64) NOT NULL,
	"provider_ref_id" text,
	"status" "withdrawal_status" NOT NULL,
	"failure_reason" text,
	"terminal_return" boolean DEFAULT false NOT NULL,
	"late_success_conflict" boolean DEFAULT false NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"lease_until" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawals_provider_request_id_unique" UNIQUE("provider_request_id"),
	CONSTRAINT "withdrawals_amount_pos_chk" CHECK ("amount" > 0 AND "fee" >= 0)
);
--> statement-breakpoint
CREATE TABLE "system_controls" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- 3. Foreign keys & consolidated indexes
ALTER TABLE "ledger_items" ADD CONSTRAINT "ledger_items_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ledger_items" ADD CONSTRAINT "ledger_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_owner_currency_type_uq" ON "accounts" USING btree ("owner_type","owner_id","currency","account_type");
--> statement-breakpoint
CREATE INDEX "ledger_items_tx_idx" ON "ledger_items" USING btree ("transaction_id");
--> statement-breakpoint
CREATE INDEX "ledger_items_user_cursor_idx" ON "ledger_items" USING btree ("user_id","id" DESC NULLS LAST) WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_tx_ref_type_uq" ON "ledger_transactions" USING btree ("reference_type","reference_id","type");
--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_psp_ref_uq" ON "deposits" USING btree ("psp_ref_id") WHERE "psp_ref_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "deposits_poll_idx" ON "deposits" USING btree ("next_poll_at") INCLUDE ("id") WHERE ("status" <> 'SUCCEEDED' AND "next_poll_at" IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "deposits_verified_at_idx" ON "deposits" USING btree ("verified_at") WHERE "status" = 'SUCCEEDED';
--> statement-breakpoint
CREATE INDEX "financial_discrepancies_open_idx" ON "financial_discrepancies" USING btree ("user_id","currency") WHERE "status" = 'OPEN';
--> statement-breakpoint
CREATE UNIQUE INDEX "financial_discrepancies_ref_type_uq" ON "financial_discrepancies" USING btree ("reference_type","reference_id","discrepancy_type");
--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency_keys" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("next_retry_at") WHERE "status" = 'PENDING';
--> statement-breakpoint
CREATE INDEX "withdrawals_dispatch_idx" ON "withdrawals" USING btree ("created_at") INCLUDE ("status","lease_until") WHERE "status" IN ('PENDING_DISPATCH', 'DISPATCHING');
--> statement-breakpoint
CREATE INDEX "withdrawals_poll_idx" ON "withdrawals" USING btree ("next_poll_at") WHERE "status" IN ('PROCESSING', 'MANUAL_REVIEW', 'FAILED') AND "next_poll_at" IS NOT NULL;
