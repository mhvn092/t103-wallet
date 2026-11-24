import { Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator.js';
import { RequireIdempotencyKey } from '../idempotency/idempotency.decorator.js';
import { TransferCreateDto } from './dto/transfer-create.dto.js';
import { TransferResponseDto } from './dto/transfer-response.dto.js';
import { TransferService } from './transfer.service.js';

@Controller('transfers')
@ApiTags('Transfers')
export class TransferController {
  constructor(private readonly _transferService: TransferService) {}

  @Post()
  @ApiOperation({
    summary: 'Atomic P2P internal transfer between two users (IRT or USDT)',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({
    description: 'Transfer settled atomically in double-entry ledger',
    type: TransferResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  async create(
    @RequireIdempotencyKey() idempotencyKey: string,
    @Body() dto: TransferCreateDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransferResponseDto> {
    const result = await this._transferService.createTransfer({
      idempotencyKey,
      dto,
    });
    res.status(result.statusCode);
    return result.body;
  }
}
