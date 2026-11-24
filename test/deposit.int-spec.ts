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
});
