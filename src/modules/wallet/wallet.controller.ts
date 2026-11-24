import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { type Currency, isCurrency } from '../../common/utils/money.js';
import { WalletService } from './wallet.service.js';
import type { UserAccountType } from './wallet.types.js';

const VALID_ACCOUNT_FILTERS = new Set<string>([
  'AVAILABLE',
  'LOCKED',
  'RECEIVABLE',
  'ALL',
]);

@ApiTags('Wallets')
@Controller('wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get(':userId')
  @ApiOperation({
    summary: 'Get user IRT & USDT balances (returns 0 balances if unseen)',
  })
  @ApiResponse({ status: 200, description: 'User wallet balances' })
  getWallet(@Param('userId') userId: string) {
    const trimmed = userId.trim();
    if (!trimmed) {
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_REQUEST,
        'userId must be non-empty',
      );
    }
    return this.walletService.getWalletBalances(trimmed);
  }

  @Get(':userId/ledger')
  @ApiOperation({ summary: 'Keyset-paginated immutable ledger entries' })
  @ApiQuery({ name: 'limit', required: false, example: '20' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({
    name: 'accountType',
    required: false,
    enum: ['AVAILABLE', 'LOCKED', 'RECEIVABLE', 'ALL'],
  })
  @ApiQuery({ name: 'currency', required: false, enum: ['IRT', 'USDT'] })
  getLedger(
    @Param('userId') userId: string,
    @Query('limit') rawLimit?: string,
    @Query('cursor') rawCursor?: string,
    @Query('accountType') rawAccountType?: string,
    @Query('currency') rawCurrency?: string,
  ) {
    const trimmedUser = userId.trim();
    if (!trimmedUser) {
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_REQUEST,
        'userId must be non-empty',
      );
    }

    let limit = 20;
    if (rawLimit !== undefined && rawLimit !== '') {
      if (!/^[1-9]\d*$/.test(rawLimit)) {
        throw new DomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.INVALID_REQUEST,
          'limit must be a positive integer between 1 and 100',
        );
      }
      const parsed = Number(rawLimit);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new DomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.INVALID_REQUEST,
          'limit must be between 1 and 100',
        );
      }
      limit = parsed;
    }

    let cursor: bigint | undefined;
    if (rawCursor !== undefined && rawCursor !== '') {
      if (!/^[1-9]\d*$/.test(rawCursor)) {
        throw new DomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.INVALID_REQUEST,
          'cursor must be a positive integer ledger item ID',
        );
      }
      cursor = BigInt(rawCursor);
    }

    let accountType: UserAccountType | 'ALL' = 'AVAILABLE';
    if (rawAccountType !== undefined && rawAccountType !== '') {
      if (!VALID_ACCOUNT_FILTERS.has(rawAccountType)) {
        throw new DomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.INVALID_REQUEST,
          'accountType must be AVAILABLE, LOCKED, RECEIVABLE, or ALL',
        );
      }
      accountType = rawAccountType as UserAccountType | 'ALL';
    }

    let currency: Currency | undefined;
    if (rawCurrency !== undefined && rawCurrency !== '') {
      if (!isCurrency(rawCurrency)) {
        throw new DomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.INVALID_REQUEST,
          'currency must be IRT or USDT',
        );
      }
      currency = rawCurrency;
    }

    return this.walletService.getUserLedger({
      userId: trimmedUser,
      limit,
      cursor,
      accountType,
      currency,
    });
  }
}
