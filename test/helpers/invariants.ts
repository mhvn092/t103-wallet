import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { expect } from 'vitest';
import type { CurrencyEnum } from '../../src/common/enums/currency.enum.js';

export async function assertGlobalFinancialInvariants(
  pool: Pool,
  dailyLimitIrt = 200_000_000n,
): Promise<void> {
  // 1. Account ownership & non-negativity invariants
  const { rows: accountRows } = await pool.query<{
    id: string;
    owner_type: string;
    normal_side: string;
    balance: string | null;
  }>(`SELECT id, owner_type, normal_side, balance FROM accounts`);

  const userAccounts: Array<{
    id: string;
    normalSide: string;
    balance: bigint;
  }> = [];

  for (const row of accountRows) {
    if (row.owner_type === 'USER') {
      expect(row.balance).not.toBeNull();
      const bal = BigInt(row.balance ?? '0');
      expect(bal >= 0n).toBe(true);
      userAccounts.push({
        id: row.id,
        normalSide: row.normal_side,
        balance: bal,
      });
    } else {
      expect(row.balance).toBeNull();
    }
  }

  // 2. Per-transaction per-currency SUM(DEBIT) == SUM(CREDIT)
  const { rows: ledgerCheckRows } = await pool.query<{
    transaction_id: string;
    currency: string;
    debit_total: string;
    credit_total: string;
    item_count: string;
  }>(`
    SELECT
      lt.id AS transaction_id,
      li.currency,
      COALESCE(SUM(CASE WHEN li.direction = 'DEBIT' THEN li.amount ELSE 0 END), 0)::text AS debit_total,
      COALESCE(SUM(CASE WHEN li.direction = 'CREDIT' THEN li.amount ELSE 0 END), 0)::text AS credit_total,
      COUNT(li.id)::text AS item_count
    FROM ledger_transactions lt
    LEFT JOIN ledger_items li ON li.transaction_id = lt.id
    GROUP BY lt.id, li.currency
  `);

  for (const txRow of ledgerCheckRows) {
    expect(Number(txRow.item_count)).toBeGreaterThanOrEqual(2);
    expect(BigInt(txRow.debit_total)).toBe(BigInt(txRow.credit_total));
  }

  // 3. Cached accounts.balance matches exact ledger_items sum per normal_side
  const { rows: sumRows } = await pool.query<{
    account_id: string;
    computed_balance: string;
  }>(`
    SELECT
      a.id AS account_id,
      COALESCE(SUM(CASE WHEN li.direction = a.normal_side THEN li.amount ELSE -li.amount END), 0)::text AS computed_balance
    FROM accounts a
    LEFT JOIN ledger_items li ON li.account_id = a.id
    WHERE a.owner_type = 'USER'
    GROUP BY a.id
  `);

  const computedByAccount = new Map(
    sumRows.map((r) => [r.account_id, BigInt(r.computed_balance)]),
  );
  for (const acc of userAccounts) {
    expect(acc.balance).toBe(computedByAccount.get(acc.id) ?? 0n);
  }

  // 4. Daily limit usage bounds (allowing explicit non-released WD_LATE_SUCCESS quota restoration)
  const { rows: limitRows } = await pool.query<{
    used_irt_amount: string;
    late_success_irt: string;
  }>(`
    SELECT
      udl.used_irt_amount,
      COALESCE(SUM(w.irt_equivalent), 0)::text AS late_success_irt
    FROM user_daily_limits udl
    LEFT JOIN withdrawals w
      ON w.user_id = udl.user_id
      AND w.limit_date = udl.limit_date
      AND w.late_success_conflict = true
      AND w.quota_released = false
    GROUP BY udl.user_id, udl.limit_date, udl.used_irt_amount
  `);
  for (const limitRow of limitRows) {
    const used = BigInt(limitRow.used_irt_amount);
    const lateExtra = BigInt(limitRow.late_success_irt);
    expect(used >= 0n && used <= dailyLimitIrt + lateExtra).toBe(true);
  }
}

export async function fundUserViaAdjustment(params: {
  app: INestApplication<App>;
  userId: string;
  currency: CurrencyEnum;
  amount: string;
  idempotencyKey: string;
}): Promise<void> {
  await request(params.app.getHttpServer())
    .post('/internal/adjustments')
    .set('Idempotency-Key', params.idempotencyKey)
    .send({
      userId: params.userId,
      currency: params.currency,
      amount: params.amount,
      reason: 'integration test funding',
    })
    .expect(201);
}

export function signPayoutPayload(rawJson: string, secret: string): string {
  return createHmac('sha256', secret).update(rawJson, 'utf8').digest('hex');
}
