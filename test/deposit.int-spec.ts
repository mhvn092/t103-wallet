import { faker } from '@faker-js/faker';
import { HttpStatus, INestApplication } from '@nestjs/common';
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
import { DomainException } from '../src/common/errors/domain.exception.js';
import { ErrorCode } from '../src/common/errors/error-codes.js';
import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrate.js';
import { DepositService } from '../src/modules/deposit/deposit.service.js';
import { PspClient } from '../src/modules/providers/psp.client.js';
import { assertGlobalFinancialInvariants } from './helpers/invariants.js';
import {
  getRequiredTestDatabaseUri,
  prepareTestEnv,
  resetTestDatabase,
} from './helpers/test-env.js';

describe('Deposit Flow & PSP Recovery (Integration)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let depositService: DepositService;

  const mockPspClient = {
    createPayment: vi.fn(),
    getPaymentStatus: vi.fn(),
    verifyPayment: vi.fn(),
  };

  beforeAll(async () => {
    prepareTestEnv();
    const dbUri = getRequiredTestDatabaseUri();
    await runMigrations(dbUri);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PspClient)
      .useValue(mockPspClient)
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();

    database = app.get(DatabaseService);
    depositService = app.get(DepositService);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetTestDatabase(database.pool);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('converts IRT to IRR on PSP create and credits IRT on callback verify', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    const token = `tok_${faker.string.alphanumeric(12)}`;
    const refId = `REF-${faker.string.numeric(8)}`;

    mockPspClient.createPayment.mockResolvedValue({
      token,
      paymentUrl: `http://psp.local/pay/${token}`,
      expiresAt: new Date(Date.now() + 600_000),
    });
    mockPspClient.getPaymentStatus.mockResolvedValue({
      kind: 'FOUND',
      status: 'PAID',
      amountIrt: 50_000n,
      refId,
    });
    mockPspClient.verifyPayment.mockResolvedValue({
      kind: 'VERIFIED',
      amountIrt: 50_000n,
      refId,
    });

    const createRes = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `dep-${faker.string.uuid()}`)
      .send({ userId, amount: '50000' })
      .expect(201);

    expect(mockPspClient.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amountIrt: 50_000n,
      }),
    );
    expect(createRes.body.status).toBe('AWAITING_PAYMENT');
    const depositId = createRes.body.depositId as string;

    const cbRes = await request(app.getHttpServer())
      .post('/webhooks/psp/callback')
      .send({ token, status: 'OK', extraSimField: 'ignored-by-controller' })
      .expect(200);
    expect(cbRes.body).toEqual({
      received: true,
      depositId,
      status: 'SUCCEEDED',
    });

    const detailRes = await request(app.getHttpServer())
      .get(`/deposits/${depositId}`)
      .expect(200);
    expect(detailRes.body.status).toBe('SUCCEEDED');
    expect(detailRes.body.verifiedAmount).toBe('50000');
    expect(detailRes.body.amountMismatch).toBe(false);
    expect(detailRes.body.pspRefId).toBe(refId);
    expect(detailRes.body.verifiedAt).toEqual(expect.any(String));

    const walletRes = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletRes.body.balances[0]).toEqual({
      currency: 'IRT',
      available: '50000',
      locked: '0',
      receivable: '0',
    });

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('keeps INIT unpaid tokens AWAITING_PAYMENT before expires_at without calling verifyPayment, then expires after TTL', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    const token = `tok_${faker.string.alphanumeric(12)}`;

    mockPspClient.createPayment.mockResolvedValue({
      token,
      paymentUrl: `http://psp.local/pay/${token}`,
      expiresAt: new Date(Date.now() + 300_000),
    });
    mockPspClient.getPaymentStatus.mockResolvedValue({
      kind: 'FOUND',
      status: 'INIT',
      amountIrt: 25_000n,
      refId: null,
    });

    const createRes = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `dep-init-${faker.string.uuid()}`)
      .send({ userId, amount: '25000' })
      .expect(201);
    const depositId = createRes.body.depositId as string;

    const beforeExpiry = await depositService.verifyDeposit(depositId);
    expect(beforeExpiry.status).toBe('AWAITING_PAYMENT');
    expect(mockPspClient.verifyPayment).not.toHaveBeenCalled();

    await database.pool.query(
      `UPDATE deposits SET expires_at = NOW() - INTERVAL '5 seconds' WHERE id = $1`,
      [depositId],
    );

    const afterExpiry = await depositService.verifyDeposit(depositId);
    expect(afterExpiry.status).toBe('FAILED');
    expect(mockPspClient.verifyPayment).not.toHaveBeenCalled();

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('recovers FAILED -> SUCCEEDED on late PAID status and handles 503 retries & idempotent verification without double credit', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    const token = `tok_${faker.string.alphanumeric(12)}`;
    const refId = `REF-${faker.string.numeric(8)}`;

    mockPspClient.createPayment.mockResolvedValue({
      token,
      paymentUrl: `http://psp.local/pay/${token}`,
      expiresAt: new Date(Date.now() + 300_000),
    });

    const createRes = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `dep-late-${faker.string.uuid()}`)
      .send({ userId, amount: '75000' })
      .expect(201);
    const depositId = createRes.body.depositId as string;

    // 1. Initial inquiry reports FAILED
    mockPspClient.getPaymentStatus.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'FAILED',
      amountIrt: null,
      refId: null,
    });
    const failedState = await depositService.verifyDeposit(depositId);
    expect(failedState.status).toBe('FAILED');

    // 2. Late PAID arrives, verify transiently returns 503 RETRYABLE_ERROR
    mockPspClient.getPaymentStatus.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'PAID',
      amountIrt: 75_000n,
      refId: null,
    });
    mockPspClient.verifyPayment.mockResolvedValueOnce({
      kind: 'RETRYABLE_ERROR',
      reason: 'PSP verify returned HTTP 503',
    });
    const stillFailed = await depositService.verifyDeposit(depositId);
    expect(stillFailed.status).toBe('FAILED');

    // 3. Subsequent inquiry reports VERIFIED + code 101 ALREADY_VERIFIED -> must recover FAILED -> SUCCEEDED
    mockPspClient.getPaymentStatus.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'VERIFIED',
      amountIrt: 75_000n,
      refId,
    });
    mockPspClient.verifyPayment.mockResolvedValueOnce({
      kind: 'VERIFIED',
      amountIrt: 75_000n,
      refId,
    });
    const recovered = await depositService.verifyDeposit(depositId);
    expect(recovered.status).toBe('SUCCEEDED');

    // 4. Duplicate callback stays idempotent
    await request(app.getHttpServer())
      .post('/webhooks/psp/callback')
      .send({ token })
      .expect(200);

    const walletRes = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletRes.body.balances[0].available).toBe('75000');

    const { rows: ledgerRows } = await database.pool.query(
      `SELECT id FROM ledger_transactions WHERE reference_id = $1 AND type = 'DEPOSIT'`,
      [depositId],
    );
    expect(ledgerRows).toHaveLength(1);

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('credits actual verified PSP amount and logs AMOUNT_MISMATCH financial discrepancy', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    const token = `tok_${faker.string.alphanumeric(12)}`;

    mockPspClient.createPayment.mockResolvedValue({
      token,
      paymentUrl: `http://psp.local/pay/${token}`,
      expiresAt: new Date(Date.now() + 300_000),
    });
    mockPspClient.getPaymentStatus.mockResolvedValue({
      kind: 'FOUND',
      status: 'PAID',
      amountIrt: 85_000n,
      refId: 'REF-MISMATCH',
    });
    mockPspClient.verifyPayment.mockResolvedValue({
      kind: 'VERIFIED',
      amountIrt: 85_000n,
      refId: 'REF-MISMATCH',
    });

    const createRes = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `dep-mm-${faker.string.uuid()}`)
      .send({ userId, amount: '100000' })
      .expect(201);
    const depositId = createRes.body.depositId as string;

    await depositService.verifyDeposit(depositId);

    const detailRes = await request(app.getHttpServer())
      .get(`/deposits/${depositId}`)
      .expect(200);
    expect(detailRes.body.requestedAmount).toBe('100000');
    expect(detailRes.body.verifiedAmount).toBe('85000');
    expect(detailRes.body.amountMismatch).toBe(true);

    const { rows: discRows } = await database.pool.query<{
      discrepancy_type: string;
      amount: string;
      status: string;
    }>(
      `SELECT discrepancy_type, amount, status FROM financial_discrepancies WHERE reference_id = $1`,
      [depositId],
    );
    expect(discRows).toEqual([
      {
        discrepancy_type: 'AMOUNT_MISMATCH',
        amount: '85000',
        status: 'OPEN',
      },
    ]);

    const walletRes = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletRes.body.balances[0].available).toBe('85000');

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('enforces leased idempotency: 409 in-flight, 201 replay, 422 payload reuse, and release on PSP 503', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    const idemKey = `dep-lease-${faker.string.uuid()}`;
    const retryKey = `dep-retry-${faker.string.uuid()}`;

    // 1. Simulate transient PSP outage releasing the idempotency slot
    mockPspClient.createPayment.mockRejectedValueOnce(
      new DomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.PROVIDER_UNAVAILABLE,
        'PSP temporarily down',
      ),
    );
    await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', retryKey)
      .send({ userId, amount: '40000' })
      .expect(503);

    mockPspClient.createPayment.mockResolvedValueOnce({
      token: `tok_${faker.string.alphanumeric(10)}`,
      paymentUrl: 'http://psp.local/pay/recovered',
      expiresAt: new Date(Date.now() + 300_000),
    });
    const recoveredRes = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', retryKey)
      .send({ userId, amount: '40000' })
      .expect(201);
    expect(recoveredRes.body.status).toBe('AWAITING_PAYMENT');

    // 2. Concurrent in-flight claim triggers 409 IDEMPOTENCY_IN_PROGRESS
    let releasePspCall!: () => void;
    const pspBarrier = new Promise<void>((resolve) => {
      releasePspCall = resolve;
    });
    let markPspStarted!: () => void;
    const pspStarted = new Promise<void>((resolve) => {
      markPspStarted = resolve;
    });

    mockPspClient.createPayment.mockImplementationOnce(async () => {
      markPspStarted();
      await pspBarrier;
      return {
        token: `tok_${faker.string.alphanumeric(10)}`,
        paymentUrl: 'http://psp.local/pay/inflight',
        expiresAt: new Date(Date.now() + 300_000),
      };
    });

    const firstReq = request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', idemKey)
      .send({ userId, amount: '60000' });
    const firstPromise = firstReq.then((r) => r);

    await pspStarted;
    const conflictRes = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', idemKey)
      .send({ userId, amount: '60000' })
      .expect(409);
    expect(conflictRes.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');

    releasePspCall();
    const firstRes = await firstPromise;
    expect(firstRes.status).toBe(201);

    const replayRes = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', idemKey)
      .send({ userId, amount: '60000' })
      .expect(201);
    expect(replayRes.body.depositId).toBe(firstRes.body.depositId);

    const reusedRes = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', idemKey)
      .send({ userId, amount: '61000' })
      .expect(422);
    expect(reusedRes.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('prevents stale INIT check past expires_at from clobbering VERIFYING and recovers expired deposits in grace window (F-03)', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    const tokenRace = `tok_race_${faker.string.alphanumeric(8)}`;

    mockPspClient.createPayment.mockResolvedValueOnce({
      token: tokenRace,
      paymentUrl: `http://psp.local/pay/${tokenRace}`,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const raceDepRes = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `dep-f03-race-${faker.string.uuid()}`)
      .send({ userId, amount: '45000' })
      .expect(201);
    const raceId = raceDepRes.body.depositId as string;

    let markInitEntered!: () => void;
    const initEntered = new Promise<void>((resolve) => {
      markInitEntered = resolve;
    });
    let releaseInitRead!: () => void;
    const initBarrier = new Promise<void>((resolve) => {
      releaseInitRead = resolve;
    });

    mockPspClient.getPaymentStatus.mockImplementationOnce(async () => {
      markInitEntered();
      await initBarrier;
      return {
        kind: 'FOUND',
        status: 'INIT',
        amountIrt: 45_000n,
        refId: null,
      };
    });

    const staleWorkerPromise = depositService.verifyDeposit(raceId);
    await initEntered;

    // Expire deposit and let Worker B observe PAID + transient 503 -> moves AWAITING_PAYMENT -> VERIFYING (v+1)
    await database.pool.query(
      `UPDATE deposits SET expires_at = NOW() - INTERVAL '5 seconds' WHERE id = $1`,
      [raceId],
    );
    mockPspClient.getPaymentStatus.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'PAID',
      amountIrt: 45_000n,
      refId: null,
    });
    mockPspClient.verifyPayment.mockResolvedValueOnce({
      kind: 'RETRYABLE_ERROR',
      reason: 'HTTP 503',
    });
    const verifyingView = await depositService.verifyDeposit(raceId);
    expect(verifyingView.status).toBe('VERIFYING');

    // Now Worker A completes stale INIT past expires_at -> version CAS must protect VERIFYING
    releaseInitRead();
    await staleWorkerPromise;

    const afterRace = await depositService.getDeposit(raceId);
    expect(afterRace.status).toBe('VERIFYING');

    // Post-expiry grace poll: expired deposit marked FAILED keeps non-null next_poll_at and settles PAID -> SUCCEEDED
    const tokenGrace = `tok_grace_${faker.string.alphanumeric(8)}`;
    mockPspClient.createPayment.mockResolvedValueOnce({
      token: tokenGrace,
      paymentUrl: `http://psp.local/pay/${tokenGrace}`,
      expiresAt: new Date(Date.now() - 5_000),
    });
    const graceDepRes = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `dep-f03-grace-${faker.string.uuid()}`)
      .send({ userId, amount: '55000' })
      .expect(201);
    const graceId = graceDepRes.body.depositId as string;

    mockPspClient.getPaymentStatus.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'INIT',
      amountIrt: 55_000n,
      refId: null,
    });
    const expiredGraceState = await depositService.verifyDeposit(graceId);
    expect(expiredGraceState.status).toBe('FAILED');

    const { rows: gracePollRows } = await database.pool.query<{
      next_poll_at: Date | null;
    }>(`SELECT next_poll_at FROM deposits WHERE id = $1`, [graceId]);
    expect(gracePollRows[0]?.next_poll_at).not.toBeNull();

    await database.pool.query(
      `UPDATE deposits SET next_poll_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [graceId],
    );
    mockPspClient.getPaymentStatus.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'PAID',
      amountIrt: 55_000n,
      refId: 'REF-GRACE',
    });
    mockPspClient.verifyPayment.mockResolvedValueOnce({
      kind: 'VERIFIED',
      amountIrt: 55_000n,
      refId: 'REF-GRACE',
    });

    const polled = await depositService.pollPendingDeposits(10);
    expect(polled).toBeGreaterThanOrEqual(1);
    const settledGrace = await depositService.getDeposit(graceId);
    expect(settledGrace.status).toBe('SUCCEEDED');

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('logs ORDER_ID_MISMATCH without crediting and flags hasIrrRemainder truncation as AMOUNT_MISMATCH (F-12)', async () => {
    const userId = `user_${faker.string.alphanumeric(8)}`;
    const token = `tok_f12_${faker.string.alphanumeric(8)}`;

    mockPspClient.createPayment.mockResolvedValueOnce({
      token,
      paymentUrl: `http://psp.local/pay/${token}`,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const depRes = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `dep-f12-${faker.string.uuid()}`)
      .send({ userId, amount: '50000' })
      .expect(201);
    const depositId = depRes.body.depositId as string;

    mockPspClient.getPaymentStatus.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'PAID',
      amountIrt: 50_000n,
      refId: 'REF-BAD-ORD',
      orderId: 'dep_wrong_order',
    });
    await depositService.verifyDeposit(depositId);
    expect(mockPspClient.verifyPayment).not.toHaveBeenCalled();

    // R-02: ORDER_ID_MISMATCH halts polling (next_poll_at = NULL) and deduplicates discrepancy rows
    const { rows: haltedRows } = await database.pool.query<{
      next_poll_at: Date | null;
    }>(`SELECT next_poll_at FROM deposits WHERE id = $1`, [depositId]);
    expect(haltedRows[0]?.next_poll_at).toBeNull();
    expect(await depositService.pollPendingDeposits(10)).toBe(0);

    mockPspClient.getPaymentStatus.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'PAID',
      amountIrt: 50_000n,
      refId: 'REF-BAD-ORD',
      orderId: 'dep_wrong_order',
    });
    await depositService.verifyDeposit(depositId);
    const { rows: mismatchDedupRows } = await database.pool.query<{
      discrepancy_type: string;
    }>(
      `SELECT discrepancy_type FROM financial_discrepancies WHERE reference_id = $1`,
      [depositId],
    );
    expect(mismatchDedupRows).toEqual([
      { discrepancy_type: 'ORDER_ID_MISMATCH' },
    ]);

    // Next attempt returns matching orderId and hasIrrRemainder: true -> logs AMOUNT_MISMATCH even if IRT integer matches
    mockPspClient.getPaymentStatus.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'PAID',
      amountIrt: 50_000n,
      refId: 'REF-REM',
      orderId: `dep_${depositId}`,
    });
    mockPspClient.verifyPayment.mockResolvedValueOnce({
      kind: 'VERIFIED',
      amountIrt: 50_000n,
      refId: 'REF-REM',
      hasIrrRemainder: true,
    });
    const settled = await depositService.verifyDeposit(depositId);
    expect(settled.status).toBe('SUCCEEDED');
    expect(settled.amountMismatch).toBe(true);

    const { rows: discRows } = await database.pool.query<{
      discrepancy_type: string;
    }>(
      `SELECT discrepancy_type FROM financial_discrepancies WHERE reference_id = $1 ORDER BY created_at ASC`,
      [depositId],
    );
    expect(discRows).toEqual([
      { discrepancy_type: 'ORDER_ID_MISMATCH' },
      { discrepancy_type: 'AMOUNT_MISMATCH' },
    ]);

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('fences expired leased idempotency slots against stale overwrite, isolates keys per user, and rejects overflow amounts (F-05, F-06, F-09)', async () => {
    const userA = `ua_${faker.string.alphanumeric(6)}`;
    const userB = `ub_${faker.string.alphanumeric(6)}`;
    const sharedKey = `dep-shared-${faker.string.uuid()}`;

    // F-06: Two distinct users with identical Idempotency-Key both succeed
    mockPspClient.createPayment.mockResolvedValueOnce({
      token: `tok_ua_${faker.string.alphanumeric(6)}`,
      paymentUrl: 'http://psp.local/pay/ua',
      expiresAt: new Date(Date.now() + 300_000),
    });
    const depA = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', sharedKey)
      .send({ userId: userA, amount: '50000' })
      .expect(201);

    mockPspClient.createPayment.mockResolvedValueOnce({
      token: `tok_ub_${faker.string.alphanumeric(6)}`,
      paymentUrl: 'http://psp.local/pay/ub',
      expiresAt: new Date(Date.now() + 300_000),
    });
    const depB = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', sharedKey)
      .send({ userId: userB, amount: '50000' })
      .expect(201);
    expect(depB.body.depositId).not.toBe(depA.body.depositId);

    // Reusing committed key with invalid amount still returns 422 IDEMPOTENCY_KEY_REUSED (not 400)
    const reuseInvalid = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', sharedKey)
      .send({ userId: userA, amount: 'not-a-number' })
      .expect(422);
    expect(reuseInvalid.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // F-09: Overflow magnitude rejected with 400 INVALID_REQUEST
    const overflow = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `dep-ovf-${faker.string.uuid()}`)
      .send({ userId: userA, amount: '1'.padEnd(41, '0') })
      .expect(400);
    expect(overflow.body.code).toBe('INVALID_REQUEST');

    // F-05: Stale request 1 finishes after lease reclaim by request 2 -> fenced with 409; replay preserves D2
    const leaseKey = `dep-fence-${faker.string.uuid()}`;
    let markReq1InPsp!: () => void;
    const req1InPsp = new Promise<void>((resolve) => {
      markReq1InPsp = resolve;
    });
    let releaseReq1!: () => void;
    const req1Barrier = new Promise<void>((resolve) => {
      releaseReq1 = resolve;
    });

    mockPspClient.createPayment.mockImplementationOnce(async () => {
      markReq1InPsp();
      await req1Barrier;
      return {
        token: `tok_stale_${faker.string.alphanumeric(6)}`,
        paymentUrl: 'http://psp.local/pay/stale',
        expiresAt: new Date(Date.now() + 300_000),
      };
    });
    const req1Promise = request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', leaseKey)
      .send({ userId: userA, amount: '70000' })
      .then((r) => r);

    await req1InPsp;
    await database.pool.query(
      `UPDATE idempotency_keys SET locked_until = NOW() - INTERVAL '1 second' WHERE key = $1`,
      [leaseKey],
    );

    mockPspClient.createPayment.mockResolvedValueOnce({
      token: `tok_win_${faker.string.alphanumeric(6)}`,
      paymentUrl: 'http://psp.local/pay/win',
      expiresAt: new Date(Date.now() + 300_000),
    });
    const req2Res = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', leaseKey)
      .send({ userId: userA, amount: '70000' })
      .expect(201);

    releaseReq1();
    const req1Res = await req1Promise;
    expect(req1Res.status).toBe(409);
    expect(req1Res.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');

    const replayWin = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', leaseKey)
      .send({ userId: userA, amount: '70000' })
      .expect(201);
    expect(replayWin.body.depositId).toBe(req2Res.body.depositId);

    await assertGlobalFinancialInvariants(database.pool);
  });
});
