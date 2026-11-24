import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  formatMinorToApi,
  parseAmountToMinor,
} from '../../common/utils/money.util.js';
import { generateUuidV7 } from '../../common/utils/uuidv7.util.js';
import { adjustments } from '../../database/schema/index.js';
import type { IdempotentExecutionResult } from '../idempotency/idempotency.types.js';
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

  async createAdjustment(params: {
    idempotencyKey: string;
    requestHash?: string;
    dto: AdjustmentCreateDto;
    operatorId: string;
  }): Promise<IdempotentExecutionResult<AdjustmentResponseDto>> {
    const { dto } = params;
    const availableSpec = {
      userId: dto.userId,
      currency: dto.currency,
      accountType: 'AVAILABLE' as const,
    };

    // Pre-ensure outside TX1 to avoid rollback bloat or XID deadlocks
    await this._walletService.ensureUserScaffold({
      accountSpecs: [availableSpec],
    });

    return this._idempotencyService.executeInTransaction<AdjustmentResponseDto>(
      {
        scope: 'POST:/internal/adjustments',
        key: params.idempotencyKey,
        requestBody: dto,
        requestHashOverride: params.requestHash,
        handler: async (tx) => {
          const amountMinor = parseAmountToMinor(dto.amount, dto.currency);
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
            'OPS_ADJUSTMENT',
            dto.currency,
          );

          const adjustmentId = generateUuidV7();
          const [adj] = await tx
            .insert(adjustments)
            .values({
              id: adjustmentId,
              userId: dto.userId,
              currency: dto.currency,
              amount: amountMinor.toString(),
              reason: dto.reason,
              operatorId: params.operatorId,
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
            type: 'OPS_ADJ',
            referenceType: 'ADJUSTMENT',
            referenceId: adjustmentId,
            description: `Manual ops adjustment: ${dto.reason}`,
            metadata: {
              operatorId: params.operatorId,
              reason: dto.reason,
            },
            postings: [
              {
                account: opsAccount,
                direction: 'DEBIT',
                amount: amountMinor,
              },
              {
                account: userAvailable,
                direction: 'CREDIT',
                amount: amountMinor,
              },
            ],
          });

          return {
            adjustmentId,
            userId: dto.userId,
            currency: dto.currency,
            amount: formatMinorToApi(amountMinor, dto.currency),
            reason: dto.reason,
            operatorId: params.operatorId,
            createdAt: adj.createdAt.toISOString(),
          };
        },
      },
    );
  }
}
