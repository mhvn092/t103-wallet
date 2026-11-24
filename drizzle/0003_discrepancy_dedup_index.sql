DELETE FROM "financial_discrepancies" a
USING "financial_discrepancies" b
WHERE a.ctid > b.ctid
  AND a.reference_type = b.reference_type
  AND a.reference_id = b.reference_id
  AND a.discrepancy_type = b.discrepancy_type;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "financial_discrepancies_ref_type_uq" ON "financial_discrepancies" USING btree ("reference_type","reference_id","discrepancy_type");
