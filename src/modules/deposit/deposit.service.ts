import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  addJitterMs,
  addPositiveJitterMs,
  computeSafeLeaseMs,
} from '../../common/utils/backoff.util.js';
import { parseAmountToMinor } from '../../common/utils/money.util.js';
import { assertValidUuid } from '../../common/utils/uuid-validation.util.js';
import { generateUuidV7 } from '../../common/utils/uuidv7.util.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { DatabaseService } from '../../database/database.service.js';
import {
  deposits,
  financialDiscrepancies,
} from '../../database/schema/index.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { PspClient } from '../providers/psp.client.js';
import { WalletService } from '../wallet/wallet.service.js';
import {
  DEPOSIT_INIT_LEASE_MS,
  DEPOSIT_POLL_BACKOFF_MS,
  DEPOSIT_POLL_CLAIM_LEASE_MS,
  ORPHAN_INITIATED_AGE_MS,
} from './deposit.constants.js';
import {
  computePostExpiryGracePollAt,
  toDepositDetailResponseDto,
} from './deposit.mapper.js';
import { pspCallbackPayloadSchema } from './deposit.schemas.js';
import type { DepositEntity } from './deposit.types.js';
import type { DepositCreateDto } from './dto/deposit-create.dto.js';
import type {
  DepositCallbackAckDto,
  DepositCreateResponseDto,
  DepositDetailResponseDto,
} from './dto/deposit-response.dto.js';

@Injectable()
export class DepositService {
  constructor(
    private readonly _configService: ConfigService<EnvConfig, true>,
    private readonly _databaseService: DatabaseService,
    private readonly _idempotencyService: IdempotencyService,
    private readonly _walletService: WalletService,
    private readonly _ledgerService: LedgerService,
    private readonly _pspClient: PspClient,
  ) {}

  async initiateDeposit(params: {
    idempotencyKey: string;
    dto: DepositCreateDto;
  }): Promise<{
    replayed: boolean;
    statusCode: number;
    body: DepositCreateResponseDto;
  }> {
    const scope = `POST:/deposits:${params.dto.userId}`;
    const claim =
      await this._idempotencyService.claimLeased<DepositCreateResponseDto>({
        scope,
        key: params.idempotencyKey,
        requestBody: params.dto,
        leaseMs: this._getDepositInitLeaseMs(),
      });
    if (claim.kind === 'REPLAY') {
      return {
        replayed: true,
        statusCode: claim.statusCode,
        body: claim.body,
      };
    }

    let settledIdempotency = false;
    try {
      const amountMinor = parseAmountToMinor(params.dto.amount, 'IRT');
      await this._walletService.ensureUserScaffold({
        accountSpecs: [
          {
            userId: params.dto.userId,
            currency: 'IRT',
            accountType: 'AVAILABLE',
          },
        ],
      });

      const depositId = generateUuidV7();
      const orderId = `dep_${depositId}`;
      const created = await this._createInitiatedDeposit(
        depositId,
        params.dto.userId,
        amountMinor,
        orderId,
      );

      const pspPayment = await this._createPspPaymentOrRelease({
        deposit: created,
        amountMinor,
        orderId,
        scope,
        idempotencyKey: params.idempotencyKey,
        leaseVersion: claim.leaseVersion,
      });
      if (!pspPayment.ok) {
        settledIdempotency = true;
        throw pspPayment.error;
      }

      const body = await this._finalizeAwaitingDeposit({
        depositId,
        createdAt: created.createdAt,
        pspPayment: pspPayment.value,
        scope,
        idempotencyKey: params.idempotencyKey,
        leaseVersion: claim.leaseVersion,
      });
      settledIdempotency = true;

      return {
        replayed: false,
        statusCode: HttpStatus.CREATED,
        body,
      };
    } finally {
      if (!settledIdempotency) {
        await this._idempotencyService
          .releaseLeased(scope, params.idempotencyKey, claim.leaseVersion)
          .catch(() => undefined);
      }
    }
  }

  async getDeposit(depositId: string): Promise<DepositDetailResponseDto> {
    const validId = assertValidUuid(depositId, 'depositId');
    const row = await this._requireDeposit(validId);
    return toDepositDetailResponseDto(row);
  }

  async handlePspCallback(rawPayload: unknown): Promise<DepositCallbackAckDto> {
    const parsed = pspCallbackPayloadSchema.safeParse(rawPayload);
    if (!parsed.success || (!parsed.data.token && !parsed.data.orderId)) {
      return { received: true };
    }

    const token = parsed.data.token ?? undefined;
    const orderId = parsed.data.orderId ?? undefined;
    const row = await this._findDepositByCallback({ token, orderId });
    if (!row) {
      return { received: true };
    }

    if (row.status === 'SUCCEEDED') {
      return {
        received: true,
        depositId: row.id,
        status: row.status,
      };
    }

    try {
      const updated = await this.verifyDeposit(row.id);
      return {
        received: true,
        depositId: updated.depositId,
        status: updated.status,
      };
    } catch (err) {
      this._logger.warn(
        `PSP callback verification deferred to poller for deposit=${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        received: true,
        depositId: row.id,
        status: row.status,
      };
    }
  }

  async verifyDeposit(depositId: string): Promise<DepositDetailResponseDto> {
    const validId = assertValidUuid(depositId, 'depositId');
    const row = await this._requireDeposit(validId);

    if (row.status === 'SUCCEEDED') {
      return toDepositDetailResponseDto(row);
    }

    if (!row.pspToken) {
      return this._handleMissingToken(row);
    }

    const inquiry = await this._pspClient.getPaymentStatus(row.pspToken);
    if (inquiry.kind === 'AMBIGUOUS') {
      return this._reschedulePoll(row, row.status);
    }

    if (inquiry.orderId && inquiry.orderId !== row.orderId) {
      return this._recordOrderIdMismatchAndHaltPolling(row, inquiry.orderId);
    }

    if (inquiry.status === 'INIT') {
      return this._handleInitStatus(row);
    }

    if (inquiry.status === 'FAILED' || inquiry.status === 'EXPIRED') {
      return this._markDepositFailedIfUnsettled(row, null);
    }

    const verifyResult = await this._pspClient.verifyPayment(row.pspToken);
    if (verifyResult.kind === 'RETRYABLE_ERROR') {
      const nextStatus = row.status === 'FAILED' ? 'FAILED' : 'VERIFYING';
      return this._reschedulePoll(row, nextStatus);
    }

    if (verifyResult.kind === 'FAILED') {
      return this._markDepositFailedIfUnsettled(row, null);
    }

    return this._settleVerifiedDeposit({
      depositId: row.id,
      verifiedAmountIrt: verifyResult.amountIrt,
      hasIrrRemainder: Boolean(verifyResult.hasIrrRemainder),
      pspRefId: verifyResult.refId ?? inquiry.refId,
    });
  }

  async pollPendingDeposits(limit = 20): Promise<number> {
    const now = new Date();
    const claimedIds = await this._databaseService.runInTransaction(
      async (tx) => {
        const dueRows = await tx
          .select({ id: deposits.id })
          .from(deposits)
          .where(
            and(
              ne(deposits.status, 'SUCCEEDED'),
              isNotNull(deposits.nextPollAt),
              lte(deposits.nextPollAt, now),
            ),
          )
          .orderBy(asc(deposits.nextPollAt))
          .limit(limit)
          .for('update', { skipLocked: true });

        if (dueRows.length === 0) {
          return [];
        }

        const ids = dueRows.map((r) => r.id);
        const pollLeaseMs = this._getPollClaimLeaseMs();
        await tx
          .update(deposits)
          .set({
            nextPollAt: new Date(
              now.getTime() + addPositiveJitterMs(pollLeaseMs),
            ),
            updatedAt: now,
          })
          .where(inArray(deposits.id, ids));

        return ids;
      },
    );

    for (const id of claimedIds) {
      try {
        await this.verifyDeposit(id);
      } catch (err) {
        this._logger.warn(
          `Deposit poller failed on deposit=${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return claimedIds.length;
  }

  private _getDepositInitLeaseMs(): number {
    const timeoutMs = this._configService.get('PROVIDER_HTTP_TIMEOUT_MS', {
      infer: true,
    });
    return computeSafeLeaseMs(DEPOSIT_INIT_LEASE_MS, timeoutMs, 1, 10_000);
  }

  private _getOrphanInitiatedAgeMs(): number {
    return Math.max(
      ORPHAN_INITIATED_AGE_MS,
      this._getDepositInitLeaseMs() + 5_000,
    );
  }

  private _getPollClaimLeaseMs(): number {
    const timeoutMs = this._configService.get('PROVIDER_HTTP_TIMEOUT_MS', {
      infer: true,
    });
    return computeSafeLeaseMs(
      DEPOSIT_POLL_CLAIM_LEASE_MS,
      timeoutMs,
      2,
      10_000,
    );
  }

  private async _createInitiatedDeposit(
    depositId: string,
    userId: string,
    amountMinor: bigint,
    orderId: string,
  ): Promise<DepositEntity> {
    const now = new Date();
    const [created] = await this._databaseService.db
      .insert(deposits)
      .values({
        id: depositId,
        userId,
        requestedAmount: amountMinor.toString(),
        orderId,
        status: 'INITIATED',
        nextPollAt: new Date(now.getTime() + this._getOrphanInitiatedAgeMs()),
      })
      .returning();

    if (!created) {
      throw new DomainException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ErrorCode.INTERNAL_ERROR,
        'Failed to create initial deposit row',
      );
    }
    return created;
  }

  private async _createPspPaymentOrRelease(params: {
    deposit: DepositEntity;
    amountMinor: bigint;
    orderId: string;
    scope: string;
    idempotencyKey: string;
    leaseVersion: bigint;
  }): Promise<
    | {
        ok: true;
        value: { token: string; paymentUrl: string; expiresAt: Date };
      }
    | { ok: false; error: unknown }
  > {
    const appPublicUrl = this._configService.get('APP_PUBLIC_URL', {
      infer: true,
    });
    const callbackUrl = `${appPublicUrl}/webhooks/psp/callback`;

    try {
      const value = await this._pspClient.createPayment({
        amountIrt: params.amountMinor,
        orderId: params.orderId,
        callbackUrl,
      });
      return { ok: true, value };
    } catch (error) {
      await this._markDepositFailedIfUnsettled(params.deposit, null).catch(
        () => undefined,
      );
      await this._idempotencyService
        .releaseLeased(params.scope, params.idempotencyKey, params.leaseVersion)
        .catch(() => undefined);
      return { ok: false, error };
    }
  }

  private async _finalizeAwaitingDeposit(params: {
    depositId: string;
    createdAt: Date;
    pspPayment: { token: string; paymentUrl: string; expiresAt: Date };
    scope: string;
    idempotencyKey: string;
    leaseVersion: bigint;
  }): Promise<DepositCreateResponseDto> {
    const now = new Date();
    const body: DepositCreateResponseDto = {
      depositId: params.depositId,
      status: 'AWAITING_PAYMENT',
      paymentUrl: params.pspPayment.paymentUrl,
      expiresAt: params.pspPayment.expiresAt.toISOString(),
      createdAt: params.createdAt.toISOString(),
    };

    await this._databaseService.runInTransaction(async (tx) => {
      await tx
        .update(deposits)
        .set({
          status: 'AWAITING_PAYMENT',
          pspToken: params.pspPayment.token,
          paymentUrl: params.pspPayment.paymentUrl,
          expiresAt: params.pspPayment.expiresAt,
          nextPollAt: new Date(
            now.getTime() + addJitterMs(DEPOSIT_POLL_BACKOFF_MS),
          ),
          version: sql`${deposits.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(deposits.id, params.depositId),
            eq(deposits.status, 'INITIATED'),
          ),
        );

      await this._idempotencyService.completeLeased({
        scope: params.scope,
        key: params.idempotencyKey,
        leaseVersion: params.leaseVersion,
        statusCode: HttpStatus.CREATED,
        body,
        executor: tx,
      });
    });

    return body;
  }

  private async _findDepositById(
    depositId: string,
  ): Promise<DepositEntity | undefined> {
    const [row] = await this._databaseService.db
      .select()
      .from(deposits)
      .where(eq(deposits.id, depositId))
      .limit(1);
    return row;
  }

  private async _findDepositByCallback(payload: {
    token?: string;
    orderId?: string;
  }): Promise<DepositEntity | undefined> {
    if (payload.token) {
      const [byToken] = await this._databaseService.db
        .select()
        .from(deposits)
        .where(eq(deposits.pspToken, payload.token))
        .limit(1);
      if (byToken) {
        return byToken;
      }
    }
    if (payload.orderId) {
      const [byOrder] = await this._databaseService.db
        .select()
        .from(deposits)
        .where(eq(deposits.orderId, payload.orderId))
        .limit(1);
      return byOrder;
    }
    return undefined;
  }

  private async _handleMissingToken(
    row: DepositEntity,
  ): Promise<DepositDetailResponseDto> {
    const ageMs = Date.now() - row.createdAt.getTime();
    if (
      row.status === 'INITIATED' &&
      ageMs >= this._getOrphanInitiatedAgeMs()
    ) {
      return this._markDepositFailedIfUnsettled(row, null);
    }
    return toDepositDetailResponseDto(row);
  }

  private async _handleInitStatus(
    row: DepositEntity,
  ): Promise<DepositDetailResponseDto> {
    const nowMs = Date.now();
    if (row.expiresAt && nowMs >= row.expiresAt.getTime()) {
      const graceMs = this._configService.get('DEPOSIT_EXPIRY_GRACE_MS', {
        infer: true,
      });
      const gracePollAt = computePostExpiryGracePollAt(
        row.expiresAt,
        nowMs,
        graceMs,
      );
      return this._markDepositFailedIfUnsettled(row, gracePollAt);
    }
    const targetStatus =
      row.status === 'FAILED' ? 'FAILED' : 'AWAITING_PAYMENT';
    return this._reschedulePoll(row, targetStatus);
  }

  private async _recordOrderIdMismatchAndHaltPolling(
    row: DepositEntity,
    actualOrderId: string,
  ): Promise<DepositDetailResponseDto> {
    this._logger.error(
      `PSP orderId mismatch on deposit=${row.id}: expected=${row.orderId} actual=${actualOrderId}`,
    );
    await this._databaseService.db
      .insert(financialDiscrepancies)
      .values({
        id: generateUuidV7(),
        referenceType: 'DEPOSIT',
        referenceId: row.id,
        userId: row.userId,
        discrepancyType: 'ORDER_ID_MISMATCH',
        amount: row.requestedAmount,
        currency: 'IRT',
        providerPayload: {
          expectedOrderId: row.orderId,
          actualOrderId,
          pspToken: row.pspToken,
        },
        status: 'OPEN',
      })
      .onConflictDoNothing({
        target: [
          financialDiscrepancies.referenceType,
          financialDiscrepancies.referenceId,
          financialDiscrepancies.discrepancyType,
        ],
      });
    return this._updateUnsettledDeposit(row, {
      status: row.status,
      nextPollAt: null,
    });
  }

  private async _reschedulePoll(
    row: DepositEntity,
    targetStatus: string,
  ): Promise<DepositDetailResponseDto> {
    return this._updateUnsettledDeposit(row, {
      status: targetStatus,
      nextPollAt: new Date(Date.now() + addJitterMs(DEPOSIT_POLL_BACKOFF_MS)),
    });
  }

  private async _markDepositFailedIfUnsettled(
    row: DepositEntity,
    nextPollAt: Date | null,
  ): Promise<DepositDetailResponseDto> {
    return this._updateUnsettledDeposit(row, {
      status: 'FAILED',
      nextPollAt,
    });
  }

  private async _updateUnsettledDeposit(
    row: DepositEntity,
    patch: { status: string; nextPollAt: Date | null },
  ): Promise<DepositDetailResponseDto> {
    const now = new Date();
    const [updated] = await this._databaseService.db
      .update(deposits)
      .set({
        status: patch.status,
        nextPollAt: patch.nextPollAt,
        version: sql`${deposits.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(deposits.id, row.id),
          eq(deposits.status, row.status),
          eq(deposits.version, row.version),
          ne(deposits.status, 'SUCCEEDED'),
        ),
      )
      .returning();

    const current = updated ?? (await this._requireDeposit(row.id));
    return toDepositDetailResponseDto(current);
  }

  private async _requireDeposit(depositId: string): Promise<DepositEntity> {
    const row = await this._findDepositById(depositId);
    if (!row) {
      throw new DomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Deposit not found',
      );
    }
    return row;
  }

  private async _settleVerifiedDeposit(params: {
    depositId: string;
    verifiedAmountIrt: bigint;
    hasIrrRemainder: boolean;
    pspRefId: string | null;
  }): Promise<DepositDetailResponseDto> {
    const preRead = await this._requireDeposit(params.depositId);
    if (preRead.status === 'SUCCEEDED') {
      return toDepositDetailResponseDto(preRead);
    }

    const availableSpec = {
      userId: preRead.userId,
      currency: 'IRT' as const,
      accountType: 'AVAILABLE' as const,
    };

    await this._walletService.ensureUserScaffold({
      accountSpecs: [availableSpec],
    });

    const settled = await this._databaseService.runInTransaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(deposits)
        .where(eq(deposits.id, params.depositId))
        .for('update')
        .limit(1);

      if (!locked) {
        throw new DomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Deposit not found',
        );
      }

      if (locked.status === 'SUCCEEDED') {
        return locked;
      }

      const lockedAccounts =
        await this._walletService.lockUserAccountsCanonical(tx, [
          availableSpec,
        ]);
      const userAvailable = this._walletService.getRequiredLockedAccount(
        lockedAccounts,
        availableSpec,
      );
      const pspClearing = await this._walletService.getSystemAccount(
        tx,
        'PSP_CLEARING',
        'IRT',
      );

      await this._ledgerService.postTransaction(tx, {
        type: 'DEPOSIT',
        referenceType: 'DEPOSIT',
        referenceId: locked.id,
        description: `PSP deposit verified (${locked.orderId})`,
        metadata: {
          orderId: locked.orderId,
          pspToken: locked.pspToken,
          pspRefId: params.pspRefId,
        },
        postings: [
          {
            account: pspClearing,
            direction: 'DEBIT',
            amount: params.verifiedAmountIrt,
          },
          {
            account: userAvailable,
            direction: 'CREDIT',
            amount: params.verifiedAmountIrt,
          },
        ],
      });

      const requestedAmount = BigInt(locked.requestedAmount);
      const amountMismatch =
        params.verifiedAmountIrt !== requestedAmount || params.hasIrrRemainder;
      const now = new Date();

      const [updated] = await tx
        .update(deposits)
        .set({
          status: 'SUCCEEDED',
          verifiedAmount: params.verifiedAmountIrt.toString(),
          amountMismatch,
          pspRefId: params.pspRefId,
          verifiedAt: now,
          nextPollAt: null,
          version: sql`${deposits.version} + 1`,
          updatedAt: now,
        })
        .where(eq(deposits.id, locked.id))
        .returning();

      if (amountMismatch) {
        await tx
          .insert(financialDiscrepancies)
          .values({
            id: generateUuidV7(),
            referenceType: 'DEPOSIT',
            referenceId: locked.id,
            userId: locked.userId,
            discrepancyType: 'AMOUNT_MISMATCH',
            amount: params.verifiedAmountIrt.toString(),
            currency: 'IRT',
            providerPayload: {
              requestedAmount: locked.requestedAmount,
              verifiedAmount: params.verifiedAmountIrt.toString(),
              hasIrrRemainder: params.hasIrrRemainder,
              pspToken: locked.pspToken,
              pspRefId: params.pspRefId,
            },
            status: 'OPEN',
          })
          .onConflictDoNothing({
            target: [
              financialDiscrepancies.referenceType,
              financialDiscrepancies.referenceId,
              financialDiscrepancies.discrepancyType,
            ],
          });
      }

      return updated ?? locked;
    });

    return toDepositDetailResponseDto(settled);
  }

  private readonly _logger = new Logger(DepositService.name);
}
