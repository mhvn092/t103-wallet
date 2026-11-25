import { HttpStatus, Injectable } from '@nestjs/common';
import {
  LedgerDirectionEnum,
  LedgerRefTypeEnum,
  LedgerTxTypeEnum,
} from '../../common/enums/ledger.enums.js';
import {
  SystemOwnerIdEnum,
  UserAccountTypeEnum,
} from '../../common/enums/account.enums.js';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  formatMinorToApi,
  parseAmountToMinor,
} from '../../common/utils/money.util.js';
import { v7 as generateUuidV7 } from 'uuid';
import { adjustments } from '../../database/schema/operations.schema.js';
import type { IdempotentExecutionResultInterface } from '../idempotency/idempotency.interface.js';
import { userIdempotencyScope } from '../idempotency/idempotency.util.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { AdjustmentCreateDto } from './dto/adjustment-create.dto.js';
import type { AdjustmentResponseDto } from './dto/adjustment-response.dto.js';

@Injectable()
export class AdjustmentService {
  constructor(
    private readonly _idempotencyService: IdempotencyService,
    private readonly _walletService: WalletService,
    private readonly _ledgerService: LedgerService,
  ) {}

  async createAdjustment(
    idempotencyKey: string,
    payload: AdjustmentCreateDto,
    operatorId: string,
    requestHash?: string,
  ): Promise<IdempotentExecutionResultInterface<AdjustmentResponseDto>> {
    const availableSpec = {
      userId: payload.userId,
      currency: payload.currency,
      accountType: UserAccountTypeEnum.AVAILABLE,
    };

    // Pre-ensure outside TX1 to avoid rollback bloat or XID deadlocks
    await this._walletService.ensureUserScaffold({
      accountSpecs: [availableSpec],
    });

    return this._idempotencyService.executeInTransaction<AdjustmentResponseDto>(
      {
        scope: userIdempotencyScope(
          'POST:/internal/adjustments',
          payload.userId,
        ),
        key: idempotencyKey,
        requestBody: payload,
        requestHashOverride: requestHash,
        handler: async (tx) => {
          const amountMinor = parseAmountToMinor(
            payload.amount,
            payload.currency,
          );
          const lockedAccounts =
            await this._walletService.lockUserAccountsCanonical(tx, [
              availableSpec,
            ]);
          const userAvailable = this._walletService.getRequiredLockedAccount(
            lockedAccounts,
            availableSpec,
          );
          const opsAccount = await this._walletService.getSystemAccount(
            tx,
            SystemOwnerIdEnum.OPS_ADJUSTMENT,
            payload.currency,
          );

          const adjustmentId = generateUuidV7();
          const [adj] = await tx
            .insert(adjustments)
            .values({
              id: adjustmentId,
              userId: payload.userId,
              currency: payload.currency,
              amount: amountMinor.toString(),
              reason: payload.reason,
              operatorId: operatorId,
            })
            .returning();

          if (!adj) {
            throw new DomainException(
              HttpStatus.INTERNAL_SERVER_ERROR,
              ErrorCode.INTERNAL_ERROR,
              'Failed to persist adjustment record',
            );
          }

          await this._ledgerService.postTransaction(tx, {
            type: LedgerTxTypeEnum.OPS_ADJ,
            referenceType: LedgerRefTypeEnum.ADJUSTMENT,
            referenceId: adjustmentId,
            description: `Manual ops adjustment: ${payload.reason}`,
            metadata: {
              operatorId: operatorId,
              reason: payload.reason,
            },
            postings: [
              {
                account: opsAccount,
                direction: LedgerDirectionEnum.DEBIT,
                amount: amountMinor,
              },
              {
                account: userAvailable,
                direction: LedgerDirectionEnum.CREDIT,
                amount: amountMinor,
              },
            ],
          });

          return {
            adjustmentId,
            userId: payload.userId,
            currency: payload.currency,
            amount: formatMinorToApi(amountMinor, payload.currency),
            reason: payload.reason,
            operatorId: operatorId,
            createdAt: adj.createdAt.toISOString(),
          };
        },
      },
    );
  }
}
