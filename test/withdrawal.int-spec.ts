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

  it('prevents duplicate or late SUCCEEDED webhook from confiscating funds after RETURNED or idempotent CANCELLED_BY_USER (F-01, F-14)', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    await fundUserViaAdjustment({
      app,
      userId,
      currency: 'IRT',
      amount: '250000',
      idempotencyKey: `fund-f01-${faker.string.uuid()}`,
    });

    // 1. Cancel withdrawal twice -> idempotent 200 OK + late SUCCEEDED webhook is ignored
    const cancelWdRes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-f01-cancel-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '100000',
        destination: VALID_IBAN,
      })
      .expect(201);
    const cancelId = cancelWdRes.body.withdrawalId as string;
    const cancelReqId = cancelWdRes.body.providerRequestId as string;

    const cancel1 = await request(app.getHttpServer())
      .post(`/withdrawals/${cancelId}/cancel`)
      .expect(200);
    const cancel2 = await request(app.getHttpServer())
      .post(`/withdrawals/${cancelId}/cancel`)
      .expect(200);
    expect(cancel1.body.status).toBe('FAILED');
    expect(cancel2.body.status).toBe('FAILED');

    const rawAfterCancel = JSON.stringify({
      requestId: cancelReqId,
      status: 'SUCCEEDED',
      refId: 'REF-IGNORED-AFTER-CANCEL',
    });
    const afterCancelAck = await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawAfterCancel, webhookSecret))
      .send(rawAfterCancel)
      .expect(200);
    expect(afterCancelAck.body.status).toBe('FAILED');

    // 2. Normal withdrawal SUCCEEDED -> RETURNED -> duplicate SUCCEEDED must NOT debit user again
    const wdRes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-f01-ret-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '100000',
        destination: VALID_IBAN,
      })
      .expect(201);
    const wdReqId = wdRes.body.providerRequestId as string;

    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'ACCEPTED',
      trackingId: 'TRK-F01',
    });
    await withdrawalService.dispatchPendingBatch();

    const rawSucceeded = JSON.stringify({
      requestId: wdReqId,
      status: 'SUCCEEDED',
      refId: 'REF-F01-1',
    });
    const sigSucceeded = signPayoutPayload(rawSucceeded, webhookSecret);
    await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', sigSucceeded)
      .send(rawSucceeded)
      .expect(200);

    const rawReturned = JSON.stringify({
      requestId: wdReqId,
      status: 'RETURNED',
      reason: 'CLOSED_ACCOUNT',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawReturned, webhookSecret))
      .send(rawReturned)
      .expect(200);

    // Duplicate/reordered SUCCEEDED arrives after bank RETURNED
    const dupSucceeded = await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', sigSucceeded)
      .send(rawSucceeded)
      .expect(200);
    expect(dupSucceeded.body.status).toBe('FAILED');

    const walletRes = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletRes.body.balances[0]).toEqual({
      currency: 'IRT',
      available: '250000',
      locked: '0',
      receivable: '0',
    });

    const { rows: lateRows } = await database.pool.query(
      `SELECT id FROM ledger_transactions WHERE type = 'WD_LATE_SUCCESS'`,
    );
    expect(lateRows).toHaveLength(0);
    await assertGlobalFinancialInvariants(database.pool);
  });

  it('offsets USER:RECEIVABLE before USER:AVAILABLE on RETURNED after WD_LATE_SUCCESS and lifts freeze cleanly (F-02, F-07)', async () => {
    const user1 = `u1_${faker.string.alphanumeric(6)}`;
    const user2 = `u2_${faker.string.alphanumeric(6)}`;
    await fundUserViaAdjustment({
      app,
      userId: user1,
      currency: 'IRT',
      amount: '100000',
      idempotencyKey: `fund-f02-${faker.string.uuid()}`,
    });

    const wdRes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-f02-${faker.string.uuid()}`)
      .send({
        userId: user1,
        currency: 'IRT',
        amount: '100000',
        destination: VALID_IBAN,
      })
      .expect(201);
    const wdId = wdRes.body.withdrawalId as string;
    const reqId = wdRes.body.providerRequestId as string;

    // Remove unused 0-balance RECEIVABLE row to verify F-07 webhook pre-scaffolding recovery
    await database.pool.query(
      `DELETE FROM accounts WHERE owner_type = 'USER' AND owner_id = $1 AND account_type = 'RECEIVABLE'`,
      [user1],
    );

    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'PERMANENT_REJECTED',
      reason: 'TEMP_GATEWAY_REJECT',
    });
    await withdrawalService.dispatchPendingBatch();

    // Transfer out 100,000 to user2 -> user1 available = 0
    await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', `xfer-f02-${faker.string.uuid()}`)
      .send({
        fromUserId: user1,
        toUserId: user2,
        currency: 'IRT',
        amount: '100000',
      })
      .expect(201);

    // Late SUCCEEDED arrives -> user1.receivable = 100,000, outbound_frozen = true
    const rawLateOk = JSON.stringify({
      requestId: reqId,
      status: 'SUCCEEDED',
      refId: 'REF-F02-LATE',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawLateOk, webhookSecret))
      .send(rawLateOk)
      .expect(200);

    // Bank subsequently returns the payout -> must extinguish RECEIVABLE first and unfreeze user1!
    const rawReturn = JSON.stringify({
      requestId: reqId,
      status: 'RETURNED',
      reason: 'BANK_RETURNED_AFTER_LATE_OK',
    });
    const retRes = await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawReturn, webhookSecret))
      .send(rawReturn)
      .expect(200);
    expect(retRes.body.status).toBe('FAILED');
    expect(retRes.body.withdrawalId).toBe(wdId);

    const u1Wallet = await request(app.getHttpServer())
      .get(`/wallets/${user1}`)
      .expect(200);
    expect(u1Wallet.body.balances[0]).toEqual({
      currency: 'IRT',
      available: '0',
      locked: '0',
      receivable: '0',
    });

    const u2Wallet = await request(app.getHttpServer())
      .get(`/wallets/${user2}`)
      .expect(200);
    expect(u2Wallet.body.balances[0].available).toBe('100000');

    const { rows: restRows } = await database.pool.query<{
      outbound_frozen: boolean;
    }>(`SELECT outbound_frozen FROM user_restrictions WHERE user_id = $1`, [
      user1,
    ]);
    expect(restRows[0]?.outbound_frozen).toBe(false);

    // Total user AVAILABLE balance equals net external deposit (100,000) with zero inflation
    const { rows: totalRows } = await database.pool.query<{ total: string }>(
      `SELECT SUM(balance)::text AS total FROM accounts WHERE owner_type = 'USER' AND account_type = 'AVAILABLE' AND currency = 'IRT'`,
    );
    expect(totalRows[0]?.total).toBe('100000');

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('uses short jittered backoff on initial 503 dispatch, escalates stalled DISPATCHING past SLA, and flags webhook payload mismatch (F-11, F-12)', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    await fundUserViaAdjustment({
      app,
      userId,
      currency: 'IRT',
      amount: '400000',
      idempotencyKey: `fund-f11-${faker.string.uuid()}`,
    });

    const wdRes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-f11-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '150000',
        destination: VALID_IBAN,
      })
      .expect(201);
    const wdId = wdRes.body.withdrawalId as string;
    const reqId = wdRes.body.providerRequestId as string;

    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'AMBIGUOUS',
      reason: 'HTTP 503',
    });
    const beforeMs = Date.now();
    await withdrawalService.dispatchPendingBatch();

    const { rows: leaseRows } = await database.pool.query<{
      status: string;
      lease_until: Date;
    }>(`SELECT status, lease_until FROM withdrawals WHERE id = $1`, [wdId]);
    expect(leaseRows[0]?.status).toBe('DISPATCHING');
    const leaseDeltaMs = leaseRows[0]!.lease_until.getTime() - beforeMs;
    expect(leaseDeltaMs).toBeGreaterThan(500);
    expect(leaseDeltaMs).toBeLessThan(10_000);

    // Age DISPATCHING row past SLA and force another ambiguous recovery inquiry -> must escalate to MANUAL_REVIEW
    await database.pool.query(
      `UPDATE withdrawals SET created_at = NOW() - INTERVAL '2 hours', lease_until = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [wdId],
    );
    mockPayoutClient.getTransfer.mockResolvedValueOnce({
      kind: 'AMBIGUOUS',
      reason: 'Payout still timing out',
    });
    await withdrawalService.dispatchPendingBatch();

    const escalated = await request(app.getHttpServer())
      .get(`/withdrawals/${wdId}`)
      .expect(200);
    expect(escalated.body.status).toBe('MANUAL_REVIEW');

    // Signed webhook with mismatched amount (9,990,000 IRR instead of 1,500,000 IRR) flags discrepancy
    const rawMismatch = JSON.stringify({
      requestId: reqId,
      status: 'SUCCEEDED',
      amount: 9_990_000,
      currency: 'IRR',
      refId: 'REF-MISMATCH-WH',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawMismatch, webhookSecret))
      .send(rawMismatch)
      .expect(200);

    const { rows: discRows } = await database.pool.query<{
      discrepancy_type: string;
    }>(
      `SELECT discrepancy_type FROM financial_discrepancies WHERE reference_id = $1`,
      [wdId],
    );
    expect(discRows).toEqual([{ discrepancy_type: 'PAYOUT_PAYLOAD_MISMATCH' }]);

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('scopes withdrawal idempotency per user, supports runtime currency pause/resume, and settles receivables via ops (F-06, F-14, F-15)', async () => {
    const userA = `wda_${faker.string.alphanumeric(6)}`;
    const userB = `wdb_${faker.string.alphanumeric(6)}`;

    for (const u of [userA, userB]) {
      await fundUserViaAdjustment({
        app,
        userId: u,
        currency: 'IRT',
        amount: '300000',
        idempotencyKey: `fund-irt-${u}-${faker.string.uuid()}`,
      });
    }
    await fundUserViaAdjustment({
      app,
      userId: userA,
      currency: 'USDT',
      amount: '30',
      idempotencyKey: `fund-usdt-${faker.string.uuid()}`,
    });

    // F-06: Two users with identical Idempotency-Key both succeed
    const sharedKey = `wd-shared-${faker.string.uuid()}`;
    const wdARes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', sharedKey)
      .send({
        userId: userA,
        currency: 'IRT',
        amount: '150000',
        destination: VALID_IBAN,
      })
      .expect(201);
    const wdBRes = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', sharedKey)
      .send({
        userId: userB,
        currency: 'IRT',
        amount: '150000',
        destination: VALID_IBAN,
      })
      .expect(201);
    expect(wdBRes.body.withdrawalId).not.toBe(wdARes.body.withdrawalId);

    // Reusing key with invalid/below-minimum payload returns 422 IDEMPOTENCY_KEY_REUSED
    const reuseInvalid = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', sharedKey)
      .send({
        userId: userA,
        currency: 'IRT',
        amount: '50000',
        destination: 'BAD-IBAN',
      })
      .expect(422);
    expect(reuseInvalid.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // F-14: Runtime kill-switch pauses USDT withdrawals while keeping IRT active
    await request(app.getHttpServer())
      .post('/internal/controls/withdrawals-pause')
      .send({ currencies: ['USDT'], reason: 'incident containment drill' })
      .expect(200);

    const pausedUsdt = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-paused-${faker.string.uuid()}`)
      .send({
        userId: userA,
        currency: 'USDT',
        amount: '10',
        destination: VALID_TRC20,
      })
      .expect(503);
    expect(pausedUsdt.body.code).toBe('SERVICE_PAUSED');

    // IRT remains operational
    await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-irt-ok-${faker.string.uuid()}`)
      .send({
        userId: userA,
        currency: 'IRT',
        amount: '100000',
        destination: VALID_IBAN,
      })
      .expect(201);

    // Resume all currencies
    await request(app.getHttpServer())
      .post('/internal/controls/withdrawals-pause')
      .send({ currencies: [] })
      .expect(200);

    await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-resumed-${faker.string.uuid()}`)
      .send({
        userId: userA,
        currency: 'USDT',
        amount: '10',
        destination: VALID_TRC20,
      })
      .expect(201);

    // F-15: Settle USER:RECEIVABLE shortfall via Ops and lift outbound freeze on userB
    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'PERMANENT_REJECTED',
      reason: 'TEMP_GATEWAY_REJECT',
    });
    // Fail ALL pending dispatches -> userA + userB get funds released cleanly
    mockPayoutClient.createTransfer.mockResolvedValue({
      kind: 'PERMANENT_REJECTED',
      reason: 'TEMP_GATEWAY_REJECT',
    });
    await withdrawalService.dispatchPendingBatch(10);

    // userB transfers all 300k away -> late SUCCEEDED on wdBRes creates 150k RECEIVABLE + freeze
    await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', `xfer-b-out-${faker.string.uuid()}`)
      .send({
        fromUserId: userB,
        toUserId: userA,
        currency: 'IRT',
        amount: '300000',
      })
      .expect(201);

    const rawLateB = JSON.stringify({
      requestId: wdBRes.body.providerRequestId as string,
      status: 'SUCCEEDED',
      refId: 'REF-SETTLE-OPS',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawLateB, webhookSecret))
      .send(rawLateB)
      .expect(200);

    // Top up userB 200k and settle 150k receivable via Ops
    await fundUserViaAdjustment({
      app,
      userId: userB,
      currency: 'IRT',
      amount: '200000',
      idempotencyKey: `fund-b-repay-${faker.string.uuid()}`,
    });

    const settleRes = await request(app.getHttpServer())
      .post('/internal/receivables/settle')
      .set('Idempotency-Key', `settle-b-${faker.string.uuid()}`)
      .send({ userId: userB, currency: 'IRT' })
      .expect(200);
    expect(settleRes.body).toMatchObject({
      userId: userB,
      currency: 'IRT',
      settledAmount: '150000',
      remainingReceivable: '0',
      outboundFrozen: false,
    });

    // Subsequent withdrawal on userB succeeds with available 50k + fresh deposit
    await fundUserViaAdjustment({
      app,
      userId: userB,
      currency: 'IRT',
      amount: '100000',
      idempotencyKey: `fund-b-ok-${faker.string.uuid()}`,
    });
    await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-b-after-${faker.string.uuid()}`)
      .send({
        userId: userB,
        currency: 'IRT',
        amount: '150000',
        destination: VALID_IBAN,
      })
      .expect(201);

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('recovers unaccepted MANUAL_REVIEW withdrawals on 404 via fenced CAS without duplicate POSTs and skips already-accepted rows (R-01, R-02)', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    await fundUserViaAdjustment({
      app,
      userId,
      currency: 'IRT',
      amount: '300000',
      idempotencyKey: `fund-r01-${faker.string.uuid()}`,
    });

    // 1. Unaccepted withdrawal hits 35-minute 503 outage -> escalated to MANUAL_REVIEW with provider_ref_id IS NULL
    const wd1Res = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-r01-unaccepted-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '100000',
        destination: VALID_IBAN,
      })
      .expect(201);
    const wd1Id = wd1Res.body.withdrawalId as string;
    const req1Id = wd1Res.body.providerRequestId as string;

    await database.pool.query(
      `UPDATE withdrawals SET created_at = NOW() - INTERVAL '35 minutes' WHERE id = $1`,
      [wd1Id],
    );

    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'AMBIGUOUS',
      reason: 'HTTP 503 outage',
    });
    await withdrawalService.dispatchPendingBatch();

    const escalated1 = await request(app.getHttpServer())
      .get(`/withdrawals/${wd1Id}`)
      .expect(200);
    expect(escalated1.body.status).toBe('MANUAL_REVIEW');
    expect(escalated1.body.providerRefId).toBeNull();

    // Payout recovers: getTransfer -> 404 NOT_FOUND, createTransfer -> ACCEPTED (held behind barrier)
    await database.pool.query(
      `UPDATE withdrawals SET next_poll_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [wd1Id],
    );

    let markCreateInFlight!: () => void;
    const createInFlight = new Promise<void>((resolve) => {
      markCreateInFlight = resolve;
    });
    let releaseCreate!: () => void;
    const createBarrier = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });

    mockPayoutClient.getTransfer.mockResolvedValueOnce({ kind: 'NOT_FOUND' });
    mockPayoutClient.createTransfer.mockImplementationOnce(async () => {
      markCreateInFlight();
      await createBarrier;
      return { kind: 'ACCEPTED', trackingId: 'TRK-R01-OK' };
    });

    const pollPromise = withdrawalService.pollProcessingBatch();
    await createInFlight;

    // While createTransfer is in flight, row is fenced in DISPATCHING with lease > timeout and concurrent workers cannot double-POST
    const { rows: midRows } = await database.pool.query<{
      status: string;
      lease_until: Date | null;
      next_poll_at: Date | null;
    }>(
      `SELECT status, lease_until, next_poll_at FROM withdrawals WHERE id = $1`,
      [wd1Id],
    );
    expect(midRows[0]?.status).toBe('DISPATCHING');
    expect(midRows[0]?.next_poll_at).toBeNull();
    expect(midRows[0]?.lease_until?.getTime()).toBeGreaterThan(
      Date.now() + 10_000,
    );

    await withdrawalService.pollProcessingBatch();
    await withdrawalService.dispatchPendingBatch();
    expect(mockPayoutClient.createTransfer).toHaveBeenCalledTimes(2);

    releaseCreate();
    await pollPromise;

    expect(mockPayoutClient.createTransfer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requestId: req1Id }),
    );
    const recovered1 = await request(app.getHttpServer())
      .get(`/withdrawals/${wd1Id}`)
      .expect(200);
    expect(recovered1.body.status).toBe('PROCESSING');
    expect(recovered1.body.providerRefId).toBe('TRK-R01-OK');

    const rawSuccess1 = JSON.stringify({
      requestId: req1Id,
      status: 'SUCCEEDED',
      refId: 'REF-R01-1',
    });
    await request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('Content-Type', 'application/json')
      .set('x-signature', signPayoutPayload(rawSuccess1, webhookSecret))
      .send(rawSuccess1)
      .expect(200);

    // 2. Previously accepted withdrawal (providerRefId !== null) in MANUAL_REVIEW must NOT re-POST on 404
    const wd2Res = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `wd-r01-accepted-${faker.string.uuid()}`)
      .send({
        userId,
        currency: 'IRT',
        amount: '100000',
        destination: VALID_IBAN,
      })
      .expect(201);
    const wd2Id = wd2Res.body.withdrawalId as string;

    mockPayoutClient.createTransfer.mockResolvedValueOnce({
      kind: 'ACCEPTED',
      trackingId: 'TRK-EXISTING',
    });
    await withdrawalService.dispatchPendingBatch();

    await database.pool.query(
      `UPDATE withdrawals SET created_at = NOW() - INTERVAL '35 minutes', next_poll_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [wd2Id],
    );
    mockPayoutClient.getTransfer.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'PROCESSING',
      providerRefId: 'TRK-EXISTING',
      failureReason: null,
    });
    await withdrawalService.pollProcessingBatch();

    await database.pool.query(
      `UPDATE withdrawals SET next_poll_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [wd2Id],
    );
    mockPayoutClient.getTransfer.mockResolvedValueOnce({ kind: 'NOT_FOUND' });
    await withdrawalService.pollProcessingBatch();

    expect(mockPayoutClient.createTransfer).toHaveBeenCalledTimes(3);
    const stillManual = await request(app.getHttpServer())
      .get(`/withdrawals/${wd2Id}`)
      .expect(200);
    expect(stillManual.body.status).toBe('MANUAL_REVIEW');
    expect(stillManual.body.providerRefId).toBe('TRK-EXISTING');

    await assertGlobalFinancialInvariants(database.pool);
  });
});
