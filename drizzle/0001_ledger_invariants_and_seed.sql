-- 1. Track creating transaction XID so items can never be appended post-commit
ALTER TABLE "ledger_transactions" ADD COLUMN "tx_xid" xid8 NOT NULL DEFAULT pg_current_xact_id();
--> statement-breakpoint

-- 2. Domain CHECK constraints
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_type_chk" CHECK ("owner_type" IN ('USER', 'SYSTEM'));
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_chk" CHECK ("currency" IN ('IRT', 'USDT'));
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_normal_side_chk" CHECK ("normal_side" IN ('DEBIT', 'CREDIT'));
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_balance_chk" CHECK (("owner_type" = 'SYSTEM' AND "balance" IS NULL) OR ("owner_type" = 'USER' AND "balance" >= 0));
--> statement-breakpoint
ALTER TABLE "ledger_items" ADD CONSTRAINT "ledger_items_direction_chk" CHECK ("direction" IN ('DEBIT', 'CREDIT'));
--> statement-breakpoint
ALTER TABLE "ledger_items" ADD CONSTRAINT "ledger_items_currency_chk" CHECK ("currency" IN ('IRT', 'USDT'));
--> statement-breakpoint
ALTER TABLE "ledger_items" ADD CONSTRAINT "ledger_items_amount_pos_chk" CHECK ("amount" > 0);
--> statement-breakpoint
ALTER TABLE "user_daily_limits" ADD CONSTRAINT "user_daily_limits_nonneg_chk" CHECK ("used_irt_amount" >= 0);
--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_requested_pos_chk" CHECK ("requested_amount" > 0);
--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_amount_pos_chk" CHECK ("amount" > 0 AND "fee" >= 0);
--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_amount_pos_chk" CHECK ("amount" > 0);
--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_amount_pos_chk" CHECK ("amount" > 0 AND "from_user_id" <> "to_user_id");
--> statement-breakpoint

-- 3. Append-only immutability trigger for ledger tables
CREATE OR REPLACE FUNCTION fn_forbid_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Ledger table % is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_ledger_transactions_append_only
BEFORE UPDATE OR DELETE ON "ledger_transactions"
FOR EACH ROW EXECUTE FUNCTION fn_forbid_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_ledger_items_append_only
BEFORE UPDATE OR DELETE ON "ledger_items"
FOR EACH ROW EXECUTE FUNCTION fn_forbid_ledger_mutation();
--> statement-breakpoint

-- 4. Guard preventing direct SQL/ORM edits to accounts.balance outside ledger trigger
CREATE OR REPLACE FUNCTION fn_forbid_direct_balance_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() <= 1 OR current_setting('t103.allow_balance_update', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Direct updates to accounts.balance are forbidden; post a ledger transaction instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_accounts_no_direct_balance_update
BEFORE UPDATE OF "balance" ON "accounts"
FOR EACH ROW EXECUTE FUNCTION fn_forbid_direct_balance_update();
--> statement-breakpoint

-- 5. Materialize USER account balances & balance_after inside BEFORE INSERT ON ledger_items
--    SYSTEM accounts keep balance IS NULL and are NEVER locked or updated.
CREATE OR REPLACE FUNCTION fn_ledger_item_project_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tx_xid xid8;
  v_owner_type text;
  v_owner_id text;
  v_currency text;
  v_account_type text;
  v_normal_side text;
  v_delta numeric(38, 0);
  v_new_balance numeric(38, 0);
BEGIN
  SELECT tx_xid INTO v_tx_xid
  FROM "ledger_transactions"
  WHERE id = NEW.transaction_id;

  IF NOT FOUND OR v_tx_xid <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'Cannot insert ledger_items outside the creating transaction (tx=%)', NEW.transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Deliberately NO FOR UPDATE here so SYSTEM clearing rows are never locked
  SELECT owner_type, owner_id, currency, account_type, normal_side
  INTO v_owner_type, v_owner_id, v_currency, v_account_type, v_normal_side
  FROM "accounts"
  WHERE id = NEW.account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % does not exist', NEW.account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.currency <> v_currency OR NEW.account_type <> v_account_type THEN
    RAISE EXCEPTION 'Ledger item metadata mismatch for account %', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_owner_type = 'SYSTEM' THEN
    IF NEW.user_id IS NOT NULL THEN
      RAISE EXCEPTION 'SYSTEM ledger items must have user_id IS NULL'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.balance_after := NULL;
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM v_owner_id THEN
    RAISE EXCEPTION 'USER ledger item user_id (%) does not match account owner (%)', NEW.user_id, v_owner_id
      USING ERRCODE = 'check_violation';
  END IF;

  v_delta := CASE
    WHEN NEW.direction = v_normal_side THEN NEW.amount
    ELSE -NEW.amount
  END;

  PERFORM set_config('t103.allow_balance_update', 'on', true);
  BEGIN
    UPDATE "accounts"
    SET balance = balance + v_delta
    WHERE id = NEW.account_id
    RETURNING balance INTO v_new_balance;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('t103.allow_balance_update', 'off', true);
    RAISE;
  END;
  PERFORM set_config('t103.allow_balance_update', 'off', true);

  NEW.balance_after := v_new_balance;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_ledger_item_project_balance
BEFORE INSERT ON "ledger_items"
FOR EACH ROW EXECUTE FUNCTION fn_ledger_item_project_balance();
--> statement-breakpoint

-- 6. Deferred commit-time constraint trigger enforcing >= 2 legs & per-currency SUM(DEBIT) = SUM(CREDIT)
CREATE OR REPLACE FUNCTION fn_ledger_tx_assert_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_count bigint;
  v_unbalanced_currency text;
BEGIN
  SELECT COUNT(*) INTO v_item_count
  FROM "ledger_items"
  WHERE transaction_id = NEW.id;

  IF v_item_count < 2 THEN
    RAISE EXCEPTION 'Ledger transaction % must have at least 2 items (found %)', NEW.id, v_item_count
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT currency INTO v_unbalanced_currency
  FROM "ledger_items"
  WHERE transaction_id = NEW.id
  GROUP BY currency
  HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END)
      <> SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END)
      OR SUM(amount) <= 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced for currency %', NEW.id, v_unbalanced_currency
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_ledger_tx_assert_balanced
AFTER INSERT ON "ledger_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION fn_ledger_tx_assert_balanced();
--> statement-breakpoint

-- 7. Seed exchange SYSTEM accounts (balance stays NULL forever)
INSERT INTO "accounts" ("id", "owner_type", "owner_id", "currency", "account_type", "normal_side", "balance")
VALUES
  ('01900000-0000-7000-8000-000000000001', 'SYSTEM', 'PSP_CLEARING',    'IRT',  'CLEARING',   'DEBIT',  NULL),
  ('01900000-0000-7000-8000-000000000002', 'SYSTEM', 'PAYOUT_CLEARING', 'IRT',  'CLEARING',   'DEBIT',  NULL),
  ('01900000-0000-7000-8000-000000000003', 'SYSTEM', 'OPS_ADJUSTMENT',  'IRT',  'ADJUSTMENT', 'DEBIT',  NULL),
  ('01900000-0000-7000-8000-000000000004', 'SYSTEM', 'OPS_ADJUSTMENT',  'USDT', 'ADJUSTMENT', 'DEBIT',  NULL),
  ('01900000-0000-7000-8000-000000000005', 'SYSTEM', 'PAYOUT_CLEARING', 'USDT', 'CLEARING',   'DEBIT',  NULL),
  ('01900000-0000-7000-8000-000000000006', 'SYSTEM', 'FEE_REVENUE',     'USDT', 'REVENUE',    'CREDIT', NULL)
ON CONFLICT ("owner_type", "owner_id", "currency", "account_type") DO NOTHING;
