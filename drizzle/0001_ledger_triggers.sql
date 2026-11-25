-- Concurrency & balance-integrity triggers only.
-- Structural validations (balanced debits/credits, >= 2 legs, currency/accountType/userId matching)
-- are enforced by LedgerService in the application layer before writing.

-- 1. Append-only immutability triggers for ledger tables
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
CREATE TRIGGER trg_ledger_transactions_no_truncate
BEFORE TRUNCATE ON "ledger_transactions"
FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_ledger_items_no_truncate
BEFORE TRUNCATE ON "ledger_items"
FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_ledger_mutation();
--> statement-breakpoint

-- 2. Block direct SQL/ORM updates to accounts.balance outside ledger item projection
CREATE OR REPLACE FUNCTION fn_forbid_direct_balance_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
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

-- 3. Enforce USER accounts initialize at 0 and account identity/normal_side never mutate
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
BEFORE INSERT OR UPDATE OF "owner_type", "owner_id", "currency", "account_type", "normal_side" ON "accounts"
FOR EACH ROW EXECUTE FUNCTION fn_accounts_guard_insert_and_immutable_cols();
--> statement-breakpoint

-- 4. Atomic balance projection & post-commit item-append protection inside BEFORE INSERT ON ledger_items.
--    SYSTEM accounts keep balance IS NULL and are NEVER locked or updated.
CREATE OR REPLACE FUNCTION fn_ledger_item_project_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tx_xid xid8;
  v_owner_type account_owner_type;
  v_normal_side ledger_direction;
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
  SELECT owner_type, normal_side
  INTO v_owner_type, v_normal_side
  FROM "accounts"
  WHERE id = NEW.account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % does not exist', NEW.account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_owner_type = 'SYSTEM' THEN
    NEW.balance_after := NULL;
    RETURN NEW;
  END IF;

  v_delta := CASE
    WHEN NEW.direction = v_normal_side THEN NEW.amount
    ELSE -NEW.amount
  END;

  UPDATE "accounts"
  SET balance = balance + v_delta
  WHERE id = NEW.account_id
  RETURNING balance INTO v_new_balance;

  NEW.balance_after := v_new_balance;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_ledger_item_project_balance
BEFORE INSERT ON "ledger_items"
FOR EACH ROW EXECUTE FUNCTION fn_ledger_item_project_balance();
