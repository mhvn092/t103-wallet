ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "terminal_return" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION fn_ledger_item_assert_tx_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_count bigint;
  v_unbalanced_currency text;
BEGIN
  SELECT COUNT(*) INTO v_item_count
  FROM "ledger_items"
  WHERE transaction_id = NEW.transaction_id;

  IF v_item_count < 2 THEN
    RAISE EXCEPTION 'Ledger transaction % must have at least 2 items (found %)', NEW.transaction_id, v_item_count
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT currency INTO v_unbalanced_currency
  FROM "ledger_items"
  WHERE transaction_id = NEW.transaction_id
  GROUP BY currency
  HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END)
      <> SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END)
      OR SUM(amount) <= 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced for currency %', NEW.transaction_id, v_unbalanced_currency
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_ledger_item_assert_balanced ON "ledger_items";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_ledger_item_assert_balanced
AFTER INSERT ON "ledger_items"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION fn_ledger_item_assert_tx_balanced();
