import { faker } from '@faker-js/faker';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrate.js';
import {
  assertGlobalFinancialInvariants,
  fundUserViaAdjustment,
} from './helpers/invariants.js';
import {
  getRequiredTestDatabaseUri,
  prepareTestEnv,
  resetTestDatabase,
} from './helpers/test-env.js';

describe('Internal P2P Transfers & Deadlock-Free Locking (Integration)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let baseUrl: string;

  beforeAll(async () => {
    prepareTestEnv();
    const dbUri = getRequiredTestDatabaseUri();
    await runMigrations(dbUri);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    database = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetTestDatabase(database.pool);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('handles atomic IRT & USDT transfers, validations, outbound freeze 403, and idempotency', async () => {
    const alice = `alice_${faker.string.alphanumeric(6)}`;
    const bob = `bob_${faker.string.alphanumeric(6)}`;

    await fundUserViaAdjustment({
      app,
      userId: alice,
      currency: 'IRT',
      amount: '500000',
      idempotencyKey: `fund-irt-${faker.string.uuid()}`,
    });
    await fundUserViaAdjustment({
      app,
      userId: alice,
      currency: 'USDT',
      amount: '15.25',
      idempotencyKey: `fund-usdt-${faker.string.uuid()}`,
    });

    // Self-transfer -> 400 INVALID_REQUEST
    const selfRes = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', `xfer-self-${faker.string.uuid()}`)
      .send({
        fromUserId: alice,
        toUserId: alice,
        currency: 'IRT',
        amount: '10000',
      })
      .expect(400);
    expect(selfRes.body.code).toBe('INVALID_REQUEST');

    // Insufficient balance -> 422 INSUFFICIENT_FUNDS
    const lowRes = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', `xfer-low-${faker.string.uuid()}`)
      .send({
        fromUserId: alice,
        toUserId: bob,
        currency: 'USDT',
        amount: '20',
      })
      .expect(422);
    expect(lowRes.body.code).toBe('INSUFFICIENT_FUNDS');

    // Happy atomic USDT transfer with concurrent idempotency replay & 422 key reuse
    const idemKey = `xfer-usdt-${faker.string.uuid()}`;
    const payload = {
      fromUserId: alice,
      toUserId: bob,
      currency: 'USDT',
      amount: '5.125',
    };
    const xfer1 = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', idemKey)
      .send(payload)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', idemKey)
      .send(payload)
      .expect(201);
    expect(replay.body.transferId).toBe(xfer1.body.transferId);

    const reused = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', idemKey)
      .send({ ...payload, amount: '6' })
      .expect(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Frozen sender -> 403 OUTBOUND_FROZEN
    await database.pool.query(
      `UPDATE user_restrictions SET outbound_frozen = true, freeze_reason = 'test freeze' WHERE user_id = $1`,
      [alice],
    );
    const frozenRes = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', `xfer-frozen-${faker.string.uuid()}`)
      .send({
        fromUserId: alice,
        toUserId: bob,
        currency: 'IRT',
        amount: '10000',
      })
      .expect(403);
    expect(frozenRes.body.code).toBe('OUTBOUND_FROZEN');

    // F-06: Different sender (bob) can reuse identical Idempotency-Key, while alice reusing key with invalid self-transfer returns 422
    const bobTransferRes = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', idemKey)
      .send({
        fromUserId: bob,
        toUserId: alice,
        currency: 'USDT',
        amount: '1',
      })
      .expect(201);
    expect(bobTransferRes.body.transferId).not.toBe(xfer1.body.transferId);

    const aliceInvalidReuse = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', idemKey)
      .send({
        fromUserId: alice,
        toUserId: alice,
        currency: 'USDT',
        amount: '5.125',
      })
      .expect(422);
    expect(aliceInvalidReuse.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // F-09: Overflow transfer amount returns 400 INVALID_REQUEST
    const ovfTransfer = await request(app.getHttpServer())
      .post('/transfers')
      .set('Idempotency-Key', `xfer-ovf-${faker.string.uuid()}`)
      .send({
        fromUserId: bob,
        toUserId: alice,
        currency: 'IRT',
        amount: '1'.padEnd(41, '0'),
      })
      .expect(400);
    expect(ovfTransfer.body.code).toBe('INVALID_REQUEST');

    const aliceWallet = await request(app.getHttpServer())
      .get(`/wallets/${alice}`)
      .expect(200);
    const bobWallet = await request(app.getHttpServer())
      .get(`/wallets/${bob}`)
      .expect(200);
    expect(aliceWallet.body.balances[1].available).toBe('11.125');
    expect(bobWallet.body.balances[1].available).toBe('4.125');

    await assertGlobalFinancialInvariants(database.pool);
  });

  it('executes 100 simultaneous bidirectional A<->B transfers with zero deadlocks and exact total conservation', async () => {
    const alice = `bidir_a_${faker.string.alphanumeric(6)}`;
    const bob = `bidir_b_${faker.string.alphanumeric(6)}`;

    await fundUserViaAdjustment({
      app,
      userId: alice,
      currency: 'IRT',
      amount: '5000000',
      idempotencyKey: `fund-a-${faker.string.uuid()}`,
    });
    await fundUserViaAdjustment({
      app,
      userId: bob,
      currency: 'IRT',
      amount: '5000000',
      idempotencyKey: `fund-b-${faker.string.uuid()}`,
    });

    const postTransfer = async (
      fromUserId: string,
      toUserId: string,
      amount: string,
      key: string,
    ): Promise<number> => {
      const res = await fetch(`${baseUrl}/transfers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          fromUserId,
          toUserId,
          currency: 'IRT',
          amount,
        }),
      });
      return res.status;
    };

    const jobs: Array<Promise<number>> = [];
    for (let i = 0; i < 50; i += 1) {
      jobs.push(
        postTransfer(alice, bob, '10000', `ab-${i}-${faker.string.uuid()}`),
      );
      jobs.push(
        postTransfer(bob, alice, '20000', `ba-${i}-${faker.string.uuid()}`),
      );
    }

    const statuses = await Promise.all(jobs);
    expect(statuses.every((s) => s === 201)).toBe(true);

    const aliceWallet = await request(app.getHttpServer())
      .get(`/wallets/${alice}`)
      .expect(200);
    const bobWallet = await request(app.getHttpServer())
      .get(`/wallets/${bob}`)
      .expect(200);

    // Alice: 5,000,000 - 50*10,000 + 50*20,000 = 5,500,000; Bob: 4,500,000
    expect(aliceWallet.body.balances[0].available).toBe('5500000');
    expect(bobWallet.body.balances[0].available).toBe('4500000');

    await assertGlobalFinancialInvariants(database.pool);
  }, 20_000);
});
