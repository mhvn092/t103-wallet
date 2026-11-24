import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator.js';
import { RequireIdempotencyKey } from '../idempotency/idempotency.decorator.js';
import { WithdrawalCreateDto } from './dto/withdrawal-create.dto.js';
import { WithdrawalResponseDto } from './dto/withdrawal-response.dto.js';
import { WithdrawalService } from './withdrawal.service.js';

@Controller('withdrawals')
@ApiTags('Withdrawals')
export class WithdrawalController {
  constructor(private readonly _withdrawalService: WithdrawalService) {}

  @Post()
  @ApiOperation({
    summary:
      'Create an IRT or USDT withdrawal with atomic hold and limit check',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({
    description: 'Withdrawal created and funds locked',
    type: WithdrawalResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  async create(
    @RequireIdempotencyKey() idempotencyKey: string,
    @Body() dto: WithdrawalCreateDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WithdrawalResponseDto> {
    const result = await this._withdrawalService.createWithdrawal({
      idempotencyKey,
      dto,
    });
    res.status(result.statusCode);
    return result.body;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get withdrawal status and metadata' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    description: 'Withdrawal details',
    type: WithdrawalResponseDto,
  })
  @ApiErrorResponses(HttpStatus.BAD_REQUEST, HttpStatus.NOT_FOUND)
  getWithdrawal(@Param('id') id: string): Promise<WithdrawalResponseDto> {
    return this._withdrawalService.getWithdrawal(id);
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: 'Cancel a withdrawal strictly while in PENDING_DISPATCH',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    description: 'Withdrawal cancelled and locked funds released',
    type: WithdrawalResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  @HttpCode(HttpStatus.OK)
  cancelWithdrawal(@Param('id') id: string): Promise<WithdrawalResponseDto> {
    return this._withdrawalService.cancelWithdrawal(id);
  }
}
