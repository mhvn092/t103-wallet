import { faker } from '@faker-js/faker';
import { INestApplication } from '@nestjs/common';
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

describe('Daily PSP Settlement Reconciliation (Integration)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let depositService: DepositService;

  const mockPspClient = {
    createPayment: vi.fn(),
    getPaymentStatus: vi.fn(),
    verifyPayment: vi.fn(),
    fetchSettlementCsv: vi.fn(),
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

  async function seedSucceededDeposit(params: {
    userId: string;
    amountIrt: bigint;
    refId: string;
    token: string;
  }): Promise<string> {
    mockPspClient.createPayment.mockResolvedValueOnce({
      token: params.token,
      paymentUrl: `http://psp.local/pay/${params.token}`,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const created = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `rec-dep-${faker.string.uuid()}`)
      .send({ userId: params.userId, amount: params.amountIrt.toString() })
      .expect(201);
    const depositId = created.body.depositId as string;

    mockPspClient.getPaymentStatus.mockResolvedValueOnce({
      kind: 'FOUND',
      status: 'PAID',
      amountIrt: params.amountIrt,
      refId: params.refId,
    });
    mockPspClient.verifyPayment.mockResolvedValueOnce({
      kind: 'VERIFIED',
      amountIrt: params.amountIrt,
      refId: params.refId,
    });
    await depositService.verifyDeposit(depositId);
    return depositId;
  }

  it('reconciles dirty Persian CSV against local deposits, flags all mismatch classes, and never mutates balances', async () => {
    const userId = `rec_${faker.string.alphanumeric(6)}`;
    const matchedDepositId = await seedSucceededDeposit({
      userId,
      amountIrt: 50_000n,
      refId: '1382264189',
      token: `tok_match_${faker.string.alphanumeric(6)}`,
    });
    const amountMismatchDepositId = await seedSucceededDeposit({
      userId,
      amountIrt: 100_000n,
      refId: '4929073756',
      token: `tok_diff_${faker.string.alphanumeric(6)}`,
    });
    const missingCsvDepositId = await seedSucceededDeposit({
      userId,
      amountIrt: 70_000n,
      refId: '7777777777',
      token: `tok_miss_${faker.string.alphanumeric(6)}`,
    });

    const targetDate = '2026-11-24';
    await database.pool.query(
      `UPDATE deposits SET verified_at = '2026-11-24T10:00:00Z' WHERE id = ANY($1::uuid[])`,
      [[matchedDepositId, amountMismatchDepositId, missingCsvDepositId]],
    );

    mockPspClient.fetchSettlementCsv.mockResolvedValueOnce(
      [
        'ردیف,تاریخ,شماره پیگیری,نوع تراکنش,مبلغ (ریال),شرح',
        '1,۱۴۰۵/۰۹/۰۳,0001382264189,واریز درگاه,"۵۰۰٬۰۰۰",پرداخت اینترنتی OK',
        '1,۱۴۰۵/۰۹/۰۳,0001382264189,واریز درگاه,"۵۰۰٬۰۰۰",پرداخت اینترنتی OK',
        '2,1405/09/03, 4929073756 ,واریز درگاه,"850,000",مبلغ متفاوت',
        '3,1405/09/03,0006944051731,واریز درگاه,"310,000",پرداخت اینترنتی نامشخص',
        '4,1405/09/03,TRK0a29ff53fa92a12e,برداشت پایا,"-1,500,000",انتقال به شبا',
        '5,۱۴۰۵/۰۹/۰۳,TRK0a29ff53fa92a12e,کارمزد,"-۲٬۵۰۰",کارمزد انتقال پایا',
      ].join('\r\n'),
    );

    const res = await request(app.getHttpServer())
      .post('/reconciliation/run')
      .send({ date: targetDate })
      .expect(200);

    expect(res.body.date).toBe(targetDate);
    expect(res.body.summary).toEqual({
      csvDepositCount: 3,
      localDepositCount: 3,
      matchedCount: 1,
      adjacentDayMatchedCount: 0,
      mismatchCount: 3,
      duplicateCsvRowsIgnored: 1,
    });
    expect(res.body.adjacentDayMatches).toEqual([]);
    expect(res.body.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'AMOUNT_MISMATCH',
          reference: '4929073756',
          csvAmount: '85000',
          localAmount: '100000',
          depositId: amountMismatchDepositId,
        }),
        expect.objectContaining({
          type: 'MISSING_IN_LOCAL',
          reference: '6944051731',
          csvAmount: '31000',
          localAmount: null,
        }),
        expect.objectContaining({
          type: 'MISSING_IN_CSV',
          reference: '7777777777',
          csvAmount: null,
          localAmount: '70000',
          depositId: missingCsvDepositId,
        }),
      ]),
    );

    // Read-only guarantee: wallet balance remains exact 220,000 IRT (50k + 100k + 70k)
    const walletRes = await request(app.getHttpServer())
      .get(`/wallets/${userId}`)
      .expect(200);
    expect(walletRes.body.balances[0].available).toBe('220000');

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('handles negative CSV deposit rows without 500 and consumes matched local deposits once on duplicate CSV refs (F-09, F-13)', async () => {
    const userId = `rec_dup_${faker.string.alphanumeric(6)}`;
    const singleDepId = await seedSucceededDeposit({
      userId,
      amountIrt: 50_000n,
      refId: '999888777',
      token: `tok_coll_${faker.string.alphanumeric(6)}`,
    });

    const targetDate = '2026-11-25';
    await database.pool.query(
      `UPDATE deposits SET verified_at = '2026-11-25T10:00:00Z' WHERE id = $1`,
      [singleDepId],
    );

    mockPspClient.fetchSettlementCsv.mockResolvedValueOnce(
      [
        'ردیف,تاریخ,شماره پیگیری,نوع تراکنش,مبلغ (ریال),شرح',
        '1,۱۴۰۵/۰۹/۰۴,000999888777,واریز درگاه,"500,000",اولین رکورد',
        '2,۱۴۰۵/۰۹/۰۴,999888777,واریز درگاه,"600,000",رکورد تکراری با مبلغ متفاوت',
        '3,۱۴۰۵/۰۹/۰۴,555444333,واریز درگاه,"-250,000",مبلغ منفی خراب',
      ].join('\r\n'),
    );

    const res = await request(app.getHttpServer())
      .post('/reconciliation/run')
      .send({ date: targetDate })
      .expect(200);

    expect(res.body.summary).toEqual({
      csvDepositCount: 3,
      localDepositCount: 1,
      matchedCount: 1,
      adjacentDayMatchedCount: 0,
      mismatchCount: 2,
      duplicateCsvRowsIgnored: 0,
    });
    expect(res.body.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'MISSING_IN_LOCAL',
          reference: '999888777',
          csvAmount: '60000',
        }),
        expect.objectContaining({
          type: 'AMOUNT_MISMATCH',
          reference: '555444333',
          csvAmount: '-25000',
        }),
      ]),
    );

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('surfaces adjacent-day cutoff matches explicitly and preserves distinct rowNumber CSV entries (F-10)', async () => {
    const userId = `rec_adj_${faker.string.alphanumeric(6)}`;
    const midnightDepId = await seedSucceededDeposit({
      userId,
      amountIrt: 80_000n,
      refId: '123450001',
      token: `tok_adj_${faker.string.alphanumeric(6)}`,
    });
    const sameDayDepA = await seedSucceededDeposit({
      userId,
      amountIrt: 50_000n,
      refId: '555666777',
      token: `tok_sd_a_${faker.string.alphanumeric(6)}`,
    });
    const sameDayDepB = await seedSucceededDeposit({
      userId,
      amountIrt: 50_000n,
      refId: '555666777',
      token: `tok_sd_b_${faker.string.alphanumeric(6)}`,
    });

    await database.pool.query(
      `UPDATE deposits SET verified_at = '2026-11-23T23:59:30Z' WHERE id = $1`,
      [midnightDepId],
    );
    await database.pool.query(
      `UPDATE deposits SET verified_at = '2026-11-24T12:00:00Z' WHERE id = ANY($1::uuid[])`,
      [[sameDayDepA, sameDayDepB]],
    );

    mockPspClient.fetchSettlementCsv.mockResolvedValueOnce(
      [
        'ردیف,تاریخ,شماره پیگیری,نوع تراکنش,مبلغ (ریال),شرح',
        '1,۱۴۰۵/۰۹/۰۳,000123450001,واریز درگاه,"800,000",تسویه نیمه‌شب',
        '2,۱۴۰۵/۰۹/۰۳,555666777,واریز درگاه,"500,000",اولین تراکنش با مرجع مشترک',
        '3,۱۴۰۵/۰۹/۰۳,555666777,واریز درگاه,"500,000",دومین تراکنش با ردیف متفاوت',
      ].join('\r\n'),
    );

    const res = await request(app.getHttpServer())
      .post('/reconciliation/run')
      .send({ date: '2026-11-24' })
      .expect(200);

    expect(res.body.summary).toEqual({
      csvDepositCount: 3,
      localDepositCount: 2,
      matchedCount: 3,
      adjacentDayMatchedCount: 1,
      mismatchCount: 0,
      duplicateCsvRowsIgnored: 0,
    });
    expect(res.body.adjacentDayMatches).toEqual([
      expect.objectContaining({
        type: 'MATCHED_ADJACENT_DAY',
        reference: '123450001',
        csvAmount: '80000',
        localAmount: '80000',
        depositId: midnightDepId,
      }),
    ]);

    await assertGlobalFinancialInvariants(database.pool);
  });
});
