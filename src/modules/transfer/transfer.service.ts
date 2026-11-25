import { HttpStatus, Injectable } from '@nestjs/common';
import {
  LedgerDirectionEnum,
  LedgerRefTypeEnum,
  LedgerTxTypeEnum,
} from '../../common/enums/ledger.enums.js';
import { UserAccountTypeEnum } from '../../common/enums/account.enums.js';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  formatMinorToApi,
  parseAmountToMinor,
} from '../../common/utils/money.util.js';
import { v7 as generateUuidV7 } from 'uuid';
import { transfers } from '../../database/schema/operations.schema.js';
import type { IdempotentExecutionResultInterface } from '../idempotency/idempotency.interface.js';
import { userIdempotencyScope } from '../idempotency/idempotency.util.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { TransferCreateDto } from './dto/transfer-create.dto.js';
import type { TransferResponseDto } from './dto/transfer-response.dto.js';

@Injectable()
export class TransferService {
  constructor(
    private readonly _idempotencyService: IdempotencyService,
    private readonly _walletService: WalletService,
    private readonly _ledgerService: LedgerService,
  ) {}

  async createTransfer(params: {
    idempotencyKey: string;
    requestHash?: string;
    dto: TransferCreateDto;
  }): Promise<IdempotentExecutionResultInterface<TransferResponseDto>> {
    const { dto } = params;
    const fromSpec = {
      userId: dto.fromUserId,
      currency: dto.currency,
      accountType: UserAccountTypeEnum.AVAILABLE,
    };
    const toSpec = {
      userId: dto.toUserId,
      currency: dto.currency,
      accountType: UserAccountTypeEnum.AVAILABLE,
    };

    await this._walletService.ensureUserScaffold({
      accountSpecs: [fromSpec, toSpec],
      restrictionUserIds: [dto.fromUserId],
    });

    return this._idempotencyService.executeInTransaction<TransferResponseDto>({
      scope: userIdempotencyScope('POST:/transfers', dto.fromUserId),
      key: params.idempotencyKey,
      requestBody: dto,
      requestHashOverride: params.requestHash,
      handler: async (tx) => {
        if (dto.fromUserId === dto.toUserId) {
          throw new DomainException(
            HttpStatus.BAD_REQUEST,
            ErrorCode.INVALID_REQUEST,
            'Sender and recipient must be different users',
          );
        }
        const amountMinor = parseAmountToMinor(dto.amount, dto.currency);
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
          type: LedgerTxTypeEnum.TRANSFER,
          referenceType: LedgerRefTypeEnum.TRANSFER,
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
              direction: LedgerDirectionEnum.DEBIT,
              amount: amountMinor,
            },
            {
              account: toAccount,
              direction: LedgerDirectionEnum.CREDIT,
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
