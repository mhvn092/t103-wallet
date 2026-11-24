CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"currency" text NOT NULL,
	"account_type" text NOT NULL,
	"normal_side" text NOT NULL,
	"balance" numeric(38, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_daily_limits" (
	"user_id" text NOT NULL,
	"limit_date" date NOT NULL,
	"used_irt_amount" numeric(38, 0) DEFAULT '0' NOT NULL,
	CONSTRAINT "user_daily_limits_user_id_limit_date_pk" PRIMARY KEY("user_id","limit_date")
);
--> statement-breakpoint
CREATE TABLE "user_restrictions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"outbound_frozen" boolean DEFAULT false NOT NULL,
	"freeze_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" text,
	"account_type" text NOT NULL,
	"currency" text NOT NULL,
	"direction" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"balance_after" numeric(38, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" uuid NOT NULL,
	"description" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"reason" text NOT NULL,
	"operator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposits_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "deposits_psp_token_unique" UNIQUE("psp_token")
);
--> statement-breakpoint
CREATE TABLE "financial_discrepancies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"discrepancy_type" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"currency" text NOT NULL,
	"provider_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"locked_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
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
	"currency" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"fee" numeric(38, 0) NOT NULL,
	"fx_rate_irt" numeric(38, 0) NOT NULL,
	"irt_equivalent" numeric(38, 0) NOT NULL,
	"limit_date" date NOT NULL,
	"quota_released" boolean DEFAULT false NOT NULL,
	"destination" text NOT NULL,
	"provider_request_id" varchar(64) NOT NULL,
	"provider_ref_id" text,
	"status" text NOT NULL,
	"failure_reason" text,
	"late_success_conflict" boolean DEFAULT false NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"lease_until" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawals_provider_request_id_unique" UNIQUE("provider_request_id")
);
--> statement-breakpoint
ALTER TABLE "ledger_items" ADD CONSTRAINT "ledger_items_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_items" ADD CONSTRAINT "ledger_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_owner_currency_type_uq" ON "accounts" USING btree ("owner_type","owner_id","currency","account_type");--> statement-breakpoint
CREATE INDEX "ledger_items_tx_idx" ON "ledger_items" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_items_account_cursor_idx" ON "ledger_items" USING btree ("account_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ledger_items_user_cursor_idx" ON "ledger_items" USING btree ("user_id","account_type","id" DESC NULLS LAST) WHERE "ledger_items"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_tx_ref_type_uq" ON "ledger_transactions" USING btree ("reference_type","reference_id","type");--> statement-breakpoint
CREATE INDEX "deposits_poll_idx" ON "deposits" USING btree ("next_poll_at") WHERE "deposits"."status" IN ('INITIATED', 'AWAITING_PAYMENT', 'VERIFYING');--> statement-breakpoint
CREATE INDEX "deposits_verified_at_idx" ON "deposits" USING btree ("verified_at") WHERE "deposits"."status" = 'SUCCEEDED';--> statement-breakpoint
CREATE INDEX "deposits_psp_ref_idx" ON "deposits" USING btree ("psp_ref_id");--> statement-breakpoint
CREATE INDEX "financial_discrepancies_user_status_idx" ON "financial_discrepancies" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("next_retry_at") WHERE "outbox_events"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "transfers_from_user_created_idx" ON "transfers" USING btree ("from_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "withdrawals_dispatch_idx" ON "withdrawals" USING btree ("created_at") WHERE "withdrawals"."status" IN ('PENDING_DISPATCH', 'DISPATCHING');--> statement-breakpoint
CREATE INDEX "withdrawals_poll_idx" ON "withdrawals" USING btree ("next_poll_at") WHERE "withdrawals"."status" IN ('PROCESSING', 'MANUAL_REVIEW');