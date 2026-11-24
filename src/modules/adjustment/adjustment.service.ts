import { Injectable } from '@nestjs/common';
import { formatMinorToApi, parseAmountToMinor } from '../../common/utils/money.js';
import { generateUuidV7 } from '../../common/utils/uuidv7.js';
import { adjustments } from '../../database/schema/index.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { CreateAdjustmentDto } from './adjustment.dto.js';

export interface AdjustmentResponse {
  adjustmentId: string;
  userId: string;
  currency: 'IRT' | 'USDT';
  amount: string;
  reason: string;
  operatorId: string;
  createdAt: string;
}

@Injectable()
export class AdjustmentService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly walletService: WalletService,
    private readonly ledgerService: LedgerService,
  ) {}

  async createAdjustment(params: {
    idempotencyKey: string;
    dto: CreateAdjustmentDto;
    operatorId: string;
  }) {
    const { dto } = params;
    const amountMinor = parseAmountToMinor(dto.amount, dto.currency);

    // Pre-ensure outside TX1 to avoid rollback bloat or XID deadlocks
    await this.walletService.ensureUserScaffold({
      accountSpecs: [
        {
          userId: dto.userId,
          currency: dto.currency,
          accountType: 'AVAILABLE',
        },
      ],
    });

    return this.idempotency.executeInTransaction<AdjustmentResponse>({
      scope: 'POST:/internal/adjustments',
      key: params.idempotencyKey,
      requestBody: dto,
      handler: async (tx) => {
        const lockedAccounts = await this.walletService.lockUserAccountsCanonical(
          tx,
          [
            {
              userId: dto.userId,
              currency: dto.currency,
              accountType: 'AVAILABLE',
            },
          ],
        );
        const userAvailable = lockedAccounts.get(
          `${dto.userId}|${dto.currency}|AVAILABLE`,
        )!;
        const opsAccount = await this.walletService.getSystemAccount(
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

        await this.ledgerService.postTransaction(tx, {
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
          createdAt: adj!.createdAt.toISOString(),
        };
      },
    });
  }
}
