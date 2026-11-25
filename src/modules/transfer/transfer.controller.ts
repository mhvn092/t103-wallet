import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  ApiErrorResponses,
  AUTHENTICATED_WRITE_ERROR_STATUSES,
} from '../../common/decorators/api-error-responses.decorator.js';
import {
  IdempotencyRequestHash,
  IdempotentRoute,
  RequireIdempotencyKey,
} from '../idempotency/idempotency.decorator.js';
import { IdempotencyPreCheckGuard } from '../idempotency/idempotency.guard.js';
import { TransferCreateDto } from './dto/transfer-create.dto.js';
import { TransferResponseDto } from './dto/transfer-response.dto.js';
import { TransferService } from './transfer.service.js';

import { WalletAccessGuard } from '../wallet/wallet-access.guard.js';

@Controller('transfers')
@UseGuards(WalletAccessGuard)
@ApiHeader({ name: 'X-Wallet-Gateway-Key', required: false })
@ApiHeader({ name: 'X-Wallet-User-Id', required: false })
@ApiTags('Transfers')
export class TransferController {
  constructor(private readonly _transferService: TransferService) {}

  @Post()
  @UseGuards(IdempotencyPreCheckGuard)
  @IdempotentRoute('POST:/transfers', { userField: 'fromUserId' })
  @ApiOperation({
    summary: 'Atomic P2P internal transfer between two users (IRT or USDT)',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({
    description: 'Transfer settled atomically in double-entry ledger',
    type: TransferResponseDto,
  })
  @ApiErrorResponses(...AUTHENTICATED_WRITE_ERROR_STATUSES)
  async create(
    @RequireIdempotencyKey() idempotencyKey: string,
    @IdempotencyRequestHash() requestHash: string | undefined,
    @Body() dto: TransferCreateDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransferResponseDto> {
    const result = await this._transferService.createTransfer({
      idempotencyKey,
      requestHash,
      dto,
    });
    res.status(result.statusCode);
    return result.body;
  }
}
