import { faker } from '@faker-js/faker';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { EnvConfig } from '../src/config/env.validation.js';
import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrate.js';
import { PayoutClient } from '../src/modules/providers/payout.client.js';
import { WithdrawalService } from '../src/modules/withdrawal/withdrawal.service.js';
import {
  assertGlobalFinancialInvariants,
  fundUserViaAdjustment,
  signPayoutPayload,
} from './helpers/invariants.js';
import {
  getRequiredTestDatabaseUri,
  prepareTestEnv,
  resetTestDatabase,
} from './helpers/test-env.js';

const VALID_IBAN = 'IR062960000000100324200001';
const VALID_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

describe('Withdrawal Lifecycle, Webhooks, Recovery & Ambiguity #1 (Integration)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let withdrawalService: WithdrawalService;
  let webhookSecret: string;

  const mockPayoutClient = {
    createTransfer: vi.fn(),
    getTransfer: vi.fn(),
  };

  beforeAll(async () => {
    prepareTestEnv();
    const dbUri = getRequiredTestDatabaseUri();
    await runMigrations(dbUri);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PayoutClient)
      .useValue(mockPayoutClient)
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();

    database = app.get(DatabaseService);
    withdrawalService = app.get(WithdrawalService);
    webhookSecret = app
      .get(ConfigService<EnvConfig, true>)
      .get('WEBHOOK_SECRET', { infer: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetTestDatabase(database.pool);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('enforces validation order: missing key, invalid destination, minimum, daily limit, insufficient funds', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    await fundUserViaAdjustment({
      app,
      userId,
      currency: 'IRT',
      amount: '500000',
      idempotencyKey: `fund-${faker.string.uuid()}`,
    });

    const missingKey = await request(app.getHttpServer())
      .post('/withdrawals')
      .send({
        userId,
        currency: 'IRT',
        amount: '100000',
        destination: VALID_IBAN,
      })
      .expect(400);
    expect(missingKey.body.code).toBe('MISSING_IDEMPOTENCY_KEY');

    const badDest = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '100000',
        destination: 'INVALID-IBAN',
      })
      .expect(400);
    expect(badDest.body.code).toBe('INVALID_DESTINATION');

    const badTrc = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'USDT',
        amount: '10',
        destination: 'TInvalidChecksum123',
      })
      .expect(400);
    expect(badTrc.body.code).toBe('INVALID_DESTINATION');

    const belowMinIrt = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '99999',
        destination: VALID_IBAN,
      })
      .expect(422);
    expect(belowMinIrt.body.code).toBe('BELOW_MINIMUM');

    const belowMinUsdt = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'USDT',
        amount: '9.999999',
        destination: VALID_TRC20,
      })
      .expect(422);
    expect(belowMinUsdt.body.code).toBe('BELOW_MINIMUM');

    const overDaily = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '200000001',
        destination: VALID_IBAN,
      })
      .expect(422);
    expect(overDaily.body.code).toBe('DAILY_LIMIT_EXCEEDED');

    const lowFunds = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '500001',
        destination: VALID_IBAN,
      })
      .expect(422);
    expect(lowFunds.body.code).toBe('INSUFFICIENT_FUNDS');

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('settles IRT withdrawal end-to-end, rejects invalid HMAC 401, and ignores stale PROCESSING webhooks', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    await fundUserViaAdjustment({
      app,
      userId,
      currency: 'IRT',
      amount: '500000',
      idempotencyKey: `fund-${faker.string.uuid()}`,
    });

    const createRes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-ok-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '250000',
        destination: VALID_IBAN,
      })
      .expect(201);
    expect(createRes.body.status).toBe('PENDING_DISPATCH');
    const withdrawalId = createRes.body.withdrawalId as string;
    const providerReqId = createRes.body.providerRequestId as string;

    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'ACCEPTED',
      trackingId: 'TRK-HAPPY-1',
    });
    const dispatched = await withdrawalService.dispatchPendingBatch();
    expect(dispatched).toBe(1);

    const procRes = await request(app.getHttpServer())
      .get(`/withdrawals/${withdrawalId}`)
      .expect(200);
    expect(procRes.body.status).toBe('PROCESSING');

    // Invalid HMAC signatures -> 401 INVALID_SIGNATURE
    const badSig = await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('x-signature', 'deadbeef')
      .send({ requestId: providerReqId, status: 'FAILED' })
      .expect(401);
    expect(badSig.body.code).toBe('INVALID_SIGNATURE');

    const missingSig = await request(app.getHttpServer())
      .post('/webhooks/payout')
      .send({ requestId: providerReqId, status: 'FAILED' })
      .expect(401);
    expect(missingSig.body.code).toBe('INVALID_SIGNATURE');

    // Valid signed SUCCEEDED webhook settles WD_SETTLE
    const rawSuccess = JSON.stringify({
      requestId: providerReqId,
      status: 'SUCCEEDED',
      refId: 'BANK-REF-1',
    });
    const successRes = await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawSuccess, webhookSecret))
      .send(rawSuccess)
      .expect(200);
    expect(successRes.body.status).toBe('SUCCEEDED');

    // Stale PROCESSING webhook must be ignored without downgrading state
    const rawStale = JSON.stringify({
      requestId: providerReqId,
      status: 'PROCESSING',
    });
    const staleRes = await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawStale, webhookSecret))
      .send(rawStale)
      .expect(200);
    expect(staleRes.body.status).toBe('SUCCEEDED');

    const walletRes = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletRes.body.balances[0]).toEqual({
      currency: 'IRT',
      available: '250000',
      locked: '0',
      receivable: '0',
    });

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('keeps DISPATCHING on 503 ambiguity, recovers 404 via same provider_request_id, and supports cancel & bank RETURN', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    await fundUserViaAdjustment({
      app,
      userId,
      currency: 'IRT',
      amount: '800000',
      idempotencyKey: `fund-${faker.string.uuid()}`,
    });

    // 1. Cancel strictly in PENDING_DISPATCH
    const cancelWdRes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-cancel-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '200000',
        destination: VALID_IBAN,
      })
      .expect(201);
    const cancelled = await request(app.getHttpServer())
      .post(`/withdrawals/${cancelWdRes.body.withdrawalId}/cancel`)
      .expect(200);
    expect(cancelled.body.status).toBe('FAILED');
    expect(cancelled.body.failureReason).toBe('CANCELLED_BY_USER');

    // 2. Dispatch ambiguity (503) -> lease expiry -> GET 404 -> re-POST identical providerRequestId
    const wdRes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-chaos-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '300000',
        destination: VALID_IBAN,
      })
      .expect(201);
    const wdId = wdRes.body.withdrawalId as string;
    const reqId = wdRes.body.providerRequestId as string;

    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'AMBIGUOUS',
      reason: 'Payout createTransfer returned HTTP 503',
    });
    await withdrawalService.dispatchPendingBatch();

    const after503 = await request(app.getHttpServer())
      .get(`/withdrawals/${wdId}`)
      .expect(200);
    expect(after503.body.status).toBe('DISPATCHING');

    // Cancelling while DISPATCHING must return 409 INVALID_STATE_TRANSITION
    const cancelConflict = await request(app.getHttpServer())
      .post(`/withdrawals/${wdId}/cancel`)
      .expect(409);
    expect(cancelConflict.body.code).toBe('INVALID_STATE_TRANSITION');

    await database.pool.query(
      `UPDATE withdrawals SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [wdId],
    );

    mockPayoutClient.getTransfer.mockResolvedValueOnce({ kind: 'NOT_FOUND' });
    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'ACCEPTED',
      trackingId: 'TRK-REPOST-1',
    });
    await withdrawalService.dispatchPendingBatch();

    expect(mockPayoutClient.getTransfer).toHaveBeenCalledWith(reqId);
    expect(mockPayoutClient.createTransfer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requestId: reqId }),
    );

    // 3. Settle, then handle bank RETURNED webhook (WD_RETURN refunds AVAILABLE & daily quota)
    const rawSuccess = JSON.stringify({
      requestId: reqId,
      status: 'SUCCEEDED',
      refId: 'REF-TO-RETURN',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawSuccess, webhookSecret))
      .send(rawSuccess)
      .expect(200);

    const rawReturn = JSON.stringify({
      requestId: reqId,
      status: 'RETURNED',
      reason: 'CLOSED_ACCOUNT',
    });
    const returnRes = await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawReturn, webhookSecret))
      .send(rawReturn)
      .expect(200);
    expect(returnRes.body.status).toBe('FAILED');

    const walletRes = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletRes.body.balances[0].available).toBe('800000');

    const { rows: limitRows } = await database.pool.query<{
      used_irt_amount: string;
    }>(`SELECT used_irt_amount FROM user_daily_limits WHERE user_id = $1`, [
      userId,
    ]);
    expect(limitRows[0]?.used_irt_amount).toBe('0');

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('executes Ambiguity #1 (WD_LATE_SUCCESS) clawback, receivable booking, discrepancy log, and 403 outbound freeze', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    await fundUserViaAdjustment({
      app,
      userId,
      currency: 'IRT',
      amount: '300000',
      idempotencyKey: `fund-${faker.string.uuid()}`,
    });

    // Withdrawal #1: 200,000 IRT fails permanently -> funds released back to 300,000 AVAILABLE
    const wd1Res = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-amb1-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '200000',
        destination: VALID_IBAN,
      })
      .expect(201);
    const wd1Id = wd1Res.body.withdrawalId as string;
    const wd1ReqId = wd1Res.body.providerRequestId as string;

    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'PERMANENT_REJECTED',
      reason: 'TEMP_GATEWAY_REJECT',
    });
    await withdrawalService.dispatchPendingBatch();

    const wd1Failed = await request(app.getHttpServer())
      .get(`/withdrawals/${wd1Id}`)
      .expect(200);
    expect(wd1Failed.body.status).toBe('FAILED');

    // Withdrawal #2: user spends 250,000 IRT legitimately, leaving only 50,000 IRT AVAILABLE
    const wd2Res = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-spend-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '250000',
        destination: VALID_IBAN,
      })
      .expect(201);
    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'ACCEPTED',
      trackingId: 'TRK-SPEND-2',
    });
    await withdrawalService.dispatchPendingBatch();

    const rawWd2Ok = JSON.stringify({
      requestId: wd2Res.body.providerRequestId as string,
      status: 'SUCCEEDED',
      refId: 'REF-SPEND-2',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawWd2Ok, webhookSecret))
      .send(rawWd2Ok)
      .expect(200);

    // Late SUCCEEDED arrives for Withdrawal #1 (200,000 total: 50,000 clawback + 150,000 receivable shortfall)
    const rawLateOk = JSON.stringify({
      requestId: wd1ReqId,
      status: 'SUCCEEDED',
      refId: 'REF-LATE-BANK-SETTLED',
    });
    const lateRes = await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawLateOk, webhookSecret))
      .send(rawLateOk)
      .expect(200);
    expect(lateRes.body.status).toBe('SUCCEEDED');

    const wd1After = await request(app.getHttpServer())
      .get(`/withdrawals/${wd1Id}`)
      .expect(200);
    expect(wd1After.body.lateSuccessConflict).toBe(true);

    const walletRes = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletRes.body.balances[0]).toEqual({
      currency: 'IRT',
      available: '0',
      locked: '0',
      receivable: '150000',
    });

    const { rows: discRows } = await database.pool.query<{
      discrepancy_type: string;
      status: string;
    }>(
      `SELECT discrepancy_type, status FROM financial_discrepancies WHERE reference_id = $1`,
      [wd1Id],
    );
    expect(discRows).toEqual([
      { discrepancy_type: 'LATE_SUCCESS_CONFLICT', status: 'OPEN' },
    ]);

    // Subsequent withdrawal must fail with 403 OUTBOUND_FROZEN even if user deposits more later
    await fundUserViaAdjustment({
      app,
      userId,
      currency: 'IRT',
      amount: '500000',
      idempotencyKey: `fund-after-freeze-${faker.string.uuid()}`,
    });
    const frozenRes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-blocked-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '100000',
        destination: VALID_IBAN,
      })
      .expect(403);
    expect(frozenRes.body.code).toBe('OUTBOUND_FROZEN');

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('handles USDT TRC20 fee split, ceiling daily limit, refund on failure, and MANUAL_REVIEW SLA escalation', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    await fundUserViaAdjustment({
      app,
      userId,
      currency: 'USDT',
      amount: '25.5',
      idempotencyKey: `fund-usdt-${faker.string.uuid()}`,
    });

    const usdtOkRes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-usdt-ok-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'USDT',
        amount: '10.5',
        destination: VALID_TRC20,
      })
      .expect(201);
    expect(usdtOkRes.body.fee).toBe('1');
    const wdOkId = usdtOkRes.body.withdrawalId as string;

    const walletMid = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletMid.body.balances[1]).toEqual({
      currency: 'USDT',
      available: '14',
      locked: '11.5',
      receivable: '0',
    });

    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'ACCEPTED',
      trackingId: 'TRK-USDT-1',
    });
    await withdrawalService.dispatchPendingBatch();

    // Force SLA exceeded while PROCESSING -> pollProcessingBatch escalates to MANUAL_REVIEW
    await database.pool.query(
      `UPDATE withdrawals SET created_at = NOW() - INTERVAL '2 hours', next_poll_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [wdOkId],
    );
    mockPayoutClient.getTransfer.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'PROCESSING',
      providerRefId: 'TRK-USDT-1',
      failureReason: null,
    });
    await withdrawalService.pollProcessingBatch();

    const manualReview = await request(app.getHttpServer())
      .get(`/withdrawals/${wdOkId}`)
      .expect(200);
    expect(manualReview.body.status).toBe('MANUAL_REVIEW');

    // Settle from MANUAL_REVIEW splits FEE_REVENUE (1 USDT) and PAYOUT_CLEARING (10.5 USDT)
    const rawUsdtOk = JSON.stringify({
      requestId: usdtOkRes.body.providerRequestId as string,
      status: 'SUCCEEDED',
      refId: 'TXHASH-1',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawUsdtOk, webhookSecret))
      .send(rawUsdtOk)
      .expect(200);

    // Second USDT withdrawal fails -> full amount + fee (11 USDT) and ceiling IRT quota refunded
    const usdtFailRes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-usdt-fail-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'USDT',
        amount: '10',
        destination: VALID_TRC20,
      })
      .expect(201);
    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'PERMANENT_REJECTED',
      reason: 'CHAIN_CONGESTION',
    });
    await withdrawalService.dispatchPendingBatch();

    const wdFailDetail = await request(app.getHttpServer())
      .get(`/withdrawals/${usdtFailRes.body.withdrawalId}`)
      .expect(200);
    expect(wdFailDetail.body.status).toBe('FAILED');

    const walletEnd = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletEnd.body.balances[1]).toEqual({
      currency: 'USDT',
      available: '14',
      locked: '0',
      receivable: '0',
    });

    const { rows: limitRows } = await database.pool.query<{
      used_irt_amount: string;
    }>(`SELECT used_irt_amount FROM user_daily_limits WHERE user_id = $1`, [
      userId,
    ]);
    // 10.5 * 60,000 = 630,000 remaining after the 10 USDT (600,000) failure refunded
    expect(limitRows[0]?.used_irt_amount).toBe('630000');

    await assertGlobalFinancialInvariants(database.pool);
  });
});
