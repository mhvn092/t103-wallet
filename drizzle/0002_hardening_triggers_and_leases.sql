-- 1. Lease/version fencing columns for idempotency_keys & deposits + expanded poll index
ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "lease_version" bigint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN IF NOT EXISTS "version" bigint DEFAULT 1 NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "deposits_poll_idx";
--> statement-breakpoint
CREATE INDEX "deposits_poll_idx" ON "deposits" USING btree ("next_poll_at") WHERE ("deposits"."status" <> 'SUCCEEDED' AND "deposits"."next_poll_at" IS NOT NULL);
--> statement-breakpoint

-- 2. Runtime control-plane flags (e.g., withdrawal currency kill-switch)
CREATE TABLE IF NOT EXISTS "system_controls" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- 3. Bind account_type <-> normal_side invariant at DB level
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_type_normal_side_chk" CHECK (
  (
    "owner_type" = 'USER' AND (
      ("account_type" IN ('AVAILABLE', 'LOCKED') AND "normal_side" = 'CREDIT')
      OR ("account_type" = 'RECEIVABLE' AND "normal_side" = 'DEBIT')
    )
  )
  OR (
    "owner_type" = 'SYSTEM' AND (
      ("account_type" IN ('CLEARING', 'ADJUSTMENT') AND "normal_side" = 'DEBIT')
      OR ("account_type" = 'REVENUE' AND "normal_side" = 'CREDIT')
    )
  )
);
--> statement-breakpoint

-- 4. Forbid non-zero initial USER balances on INSERT and forbid identity/normal_side mutations on UPDATE
CREATE OR REPLACE FUNCTION fn_accounts_guard_insert_and_immutable_cols()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.owner_type = 'USER' AND NEW.balance IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'New USER accounts must start with balance = 0'
      USING ERRCODE = 'check_violation';
  ELSIF TG_OP = 'UPDATE' AND (
    NEW.owner_type IS DISTINCT FROM OLD.owner_type OR
    NEW.owner_id IS DISTINCT FROM OLD.owner_id OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.account_type IS DISTINCT FROM OLD.account_type OR
    NEW.normal_side IS DISTINCT FROM OLD.normal_side
  ) THEN
    RAISE EXCEPTION 'Account identity and normal_side columns are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_accounts_immutable_meta
BEFORE INSERT OR UPDATE ON "accounts"
FOR EACH ROW EXECUTE FUNCTION fn_accounts_guard_insert_and_immutable_cols();
--> statement-breakpoint

-- 5. Forbid TRUNCATE on append-only ledger tables
CREATE TRIGGER trg_ledger_transactions_no_truncate
BEFORE TRUNCATE ON "ledger_transactions"
FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_ledger_items_no_truncate
BEFORE TRUNCATE ON "ledger_items"
FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_ledger_mutation();
