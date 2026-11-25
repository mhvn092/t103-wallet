import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator.js';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { WalletBalancesResponseDto } from './dto/wallet-balance-response.dto.js';
import { WalletLedgerQueryDto } from './dto/wallet-ledger-query.dto.js';
import { WalletLedgerResponseDto } from './dto/wallet-ledger-response.dto.js';
import { WalletService } from './wallet.service.js';

import { WalletAccessGuard } from './wallet-access.guard.js';

@Controller('wallets')
@UseGuards(WalletAccessGuard)
@ApiHeader({ name: 'X-Wallet-Gateway-Key', required: false })
@ApiHeader({ name: 'X-Wallet-User-Id', required: false })
@ApiTags('Wallets')
export class WalletController {
  constructor(private readonly _walletService: WalletService) {}

  @Get(':userId')
  @ApiOperation({
    summary: 'Get user IRT & USDT balances (returns 0 balances if unseen)',
  })
  @ApiParam({ name: 'userId', example: 'user_1' })
  @ApiOkResponse({
    description: 'User wallet balances',
    type: WalletBalancesResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
  )
  getWallet(
    @Param('userId') userId: string,
  ): Promise<WalletBalancesResponseDto> {
    const trimmed = userId.trim();
    if (!trimmed || trimmed.length > 128) {
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_REQUEST,
        'userId must be 1 to 128 characters',
      );
    }
    return this._walletService.getWalletBalances(trimmed);
  }

  @Get(':userId/ledger')
  @ApiOperation({ summary: 'Keyset-paginated immutable ledger entries' })
  @ApiParam({ name: 'userId', example: 'user_1' })
  @ApiOkResponse({
    description: 'Paginated ledger items for the requested user',
    type: WalletLedgerResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
  )
  getLedger(
    @Param('userId') userId: string,
    @Query() query: WalletLedgerQueryDto,
  ): Promise<WalletLedgerResponseDto> {
    const trimmedUser = userId.trim();
    if (!trimmedUser || trimmedUser.length > 128) {
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_REQUEST,
        'userId must be 1 to 128 characters',
      );
    }

    return this._walletService.getUserLedger({
      userId: trimmedUser,
      limit: query.limit,
      cursor: query.cursor !== undefined ? BigInt(query.cursor) : undefined,
      accountType: query.accountType,
      currency: query.currency,
    });
  }
}
