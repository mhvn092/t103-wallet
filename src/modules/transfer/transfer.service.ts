import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  formatMinorToApi,
  parseAmountToMinor,
} from '../../common/utils/money.js';
import { generateUuidV7 } from '../../common/utils/uuidv7.js';
import { transfers } from '../../database/schema/index.js';
import {
  IdempotencyService,
  type IdempotentExecutionResult,
} from '../idempotency/idempotency.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { TransferCreateDto } from './dto/transfer-create.dto.js';
import type { TransferResponseDto } from './dto/transfer-response.dto.js';

@Injectable()
export class TransferService {
  constructor(
    private readonly _idempotency: IdempotencyService,
    private readonly _walletService: WalletService,
    private readonly _ledgerService: LedgerService,
  ) {}

  async createTransfer(params: {
    idempotencyKey: string;
    dto: TransferCreateDto;
  }): Promise<IdempotentExecutionResult<TransferResponseDto>> {
    const { dto } = params;
    if (dto.fromUserId === dto.toUserId) {
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_REQUEST,
        'Sender and recipient must be different users',
      );
    }

    const amountMinor = parseAmountToMinor(dto.amount, dto.currency);
    const fromSpec = {
      userId: dto.fromUserId,
      currency: dto.currency,
      accountType: 'AVAILABLE' as const,
    };
    const toSpec = {
      userId: dto.toUserId,
      currency: dto.currency,
      accountType: 'AVAILABLE' as const,
    };

    await this._walletService.ensureUserScaffold({
      accountSpecs: [fromSpec, toSpec],
      restrictionUserIds: [dto.fromUserId],
    });

    return this._idempotency.executeInTransaction<TransferResponseDto>({
      scope: 'POST:/transfers',
      key: params.idempotencyKey,
      requestBody: dto,
      handler: async (tx) => {
        const frozen = await this._walletService.lockUserRestriction(
          tx,
          dto.fromUserId,
        );
        if (frozen) {
          throw new DomainException(
            HttpStatus.FORBIDDEN,
            ErrorCode.OUTBOUND_FROZEN,
            'Outbound transfers and withdrawals are frozen for this account',
          );
        }

        const lockedAccounts =
          await this._walletService.lockUserAccountsCanonical(tx, [
            fromSpec,
            toSpec,
          ]);
        const fromAccount = this._walletService.getRequiredLockedAccount(
          lockedAccounts,
          fromSpec,
        );
        const toAccount = this._walletService.getRequiredLockedAccount(
          lockedAccounts,
          toSpec,
        );

        const available = BigInt(fromAccount.balance ?? '0');
        if (available < amountMinor) {
          throw new DomainException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ErrorCode.INSUFFICIENT_FUNDS,
            'Insufficient available balance for transfer',
          );
        }

        const transferId = generateUuidV7();
        const [inserted] = await tx
          .insert(transfers)
          .values({
            id: transferId,
            fromUserId: dto.fromUserId,
            toUserId: dto.toUserId,
            currency: dto.currency,
            amount: amountMinor.toString(),
          })
          .returning();

        if (!inserted) {
          throw new DomainException(
            HttpStatus.INTERNAL_SERVER_ERROR,
            ErrorCode.INTERNAL_ERROR,
            'Failed to persist transfer record',
          );
        }

        await this._ledgerService.postTransaction(tx, {
          type: 'TRANSFER',
          referenceType: 'TRANSFER',
          referenceId: transferId,
          description: `Internal P2P transfer from ${dto.fromUserId} to ${dto.toUserId}`,
          metadata: {
            fromUserId: dto.fromUserId,
            toUserId: dto.toUserId,
            currency: dto.currency,
          },
          postings: [
            {
              account: fromAccount,
              direction: 'DEBIT',
              amount: amountMinor,
            },
            {
              account: toAccount,
              direction: 'CREDIT',
              amount: amountMinor,
            },
          ],
        });

        return {
          transferId: inserted.id,
          fromUserId: inserted.fromUserId,
          toUserId: inserted.toUserId,
          currency: dto.currency,
          amount: formatMinorToApi(amountMinor, dto.currency),
          createdAt: inserted.createdAt.toISOString(),
        };
      },
    });
  }
}
