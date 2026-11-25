DROP INDEX "withdrawals_poll_idx";
--> statement-breakpoint
CREATE INDEX "withdrawals_poll_idx" ON "withdrawals" ("next_poll_at")
WHERE "status" IN ('PROCESSING', 'MANUAL_REVIEW', 'FAILED')
  AND "next_poll_at" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_psp_ref_uq" ON "deposits" ("psp_ref_id")
WHERE "psp_ref_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "reconciled_settlement_date" date;
--> statement-breakpoint
CREATE INDEX "financial_discrepancies_open_receivable_idx"
ON "financial_discrepancies" ("user_id", "currency")
WHERE "status" = 'OPEN' AND "discrepancy_type" = 'LATE_SUCCESS_CONFLICT';
--> statement-breakpoint
UPDATE "user_restrictions" AS r
SET "freeze_reason" = 'AUTO-RECEIVABLE:' || w.id::text
FROM "withdrawals" AS w
WHERE r.user_id = w.user_id
  AND r.outbound_frozen
  AND w.late_success_conflict
  AND r.freeze_reason = 'Unrecovered shortfall on late-succeeded withdrawal ' || w.id::text;
--> statement-breakpoint
UPDATE "deposits" AS d
SET "next_poll_at" = now()
WHERE d.status IN ('AWAITING_PAYMENT', 'VERIFYING')
  AND d.next_poll_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM "financial_discrepancies" AS issue
    WHERE issue.reference_type = 'DEPOSIT' AND issue.reference_id = d.id
      AND issue.discrepancy_type = 'ORDER_ID_MISMATCH' AND issue.status = 'OPEN'
  );
--> statement-breakpoint
-- Preserve completed receipts, including the original response body and payload hash.
UPDATE "idempotency_keys" AS k
SET "scope" = k.scope || ':' || d.user_id
FROM "deposits" AS d
WHERE k.scope = 'POST:/deposits'
  AND k.status = 'COMPLETED'
  AND d.id = (k.response_body->>'depositId')::uuid;
--> statement-breakpoint
UPDATE "idempotency_keys"
SET "scope" = scope || ':' || (response_body->>'fromUserId')
WHERE scope = 'POST:/transfers' AND status = 'COMPLETED'
  AND response_body->>'fromUserId' IS NOT NULL;
--> statement-breakpoint
UPDATE "idempotency_keys"
SET "scope" = scope || ':' || (response_body->>'userId')
WHERE scope IN (
  'POST:/withdrawals',
  'POST:/withdrawals/:id/cancel',
  'POST:/internal/adjustments',
  'POST:/internal/receivables/settle'
)
  AND status = 'COMPLETED'
  AND response_body->>'userId' IS NOT NULL;
