import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator.js';
import { RequireIdempotencyKey } from '../idempotency/idempotency.decorator.js';
import { InternalMetricsResponseDto } from './dto/internal-metrics-response.dto.js';
import {
  ReceivableSettleDto,
  ReceivableSettleResponseDto,
} from './dto/receivable-settle.dto.js';
import {
  WithdrawalsPauseDto,
  WithdrawalsPauseResponseDto,
} from './dto/withdrawals-pause.dto.js';
import { InternalOpsGuard } from './internal-ops.guard.js';
import { InternalOpsService } from './internal-ops.service.js';

@Controller('internal')
@UseGuards(InternalOpsGuard)
@ApiTags('Internal Operations')
@ApiHeader({ name: 'X-Internal-Api-Key', required: false })
export class InternalOpsController {
  constructor(private readonly _internalOpsService: InternalOpsService) {}

  @Post('receivables/settle')
  @ApiOperation({
    summary:
      'Settle outstanding USER:RECEIVABLE shortfall from USER:AVAILABLE and unfreeze when zero',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Operator-Id', required: false })
  @ApiOkResponse({
    description: 'Receivable balance settled cleanly via double-entry ledger',
    type: ReceivableSettleResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  async settleReceivable(
    @RequireIdempotencyKey() idempotencyKey: string,
    @Body() dto: ReceivableSettleDto,
    @Headers('x-operator-id') rawOperatorId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReceivableSettleResponseDto> {
    const operatorId = rawOperatorId?.trim() || 'system-ops';
    const result = await this._internalOpsService.settleReceivable({
      idempotencyKey,
      dto,
      operatorId,
    });
    res.status(result.statusCode);
    return result.body;
  }

  @Post('controls/withdrawals-pause')
  @ApiOperation({
    summary: 'Pause or resume outbound withdrawals per currency at runtime',
  })
  @ApiOkResponse({
    description: 'Updated paused currencies list',
    type: WithdrawalsPauseResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
  )
  @HttpCode(HttpStatus.OK)
  pauseWithdrawals(
    @Body() dto: WithdrawalsPauseDto,
  ): Promise<WithdrawalsPauseResponseDto> {
    return this._internalOpsService.setPausedWithdrawals(dto);
  }

  @Get('metrics')
  @ApiOperation({
    summary:
      'Operational metrics for discrepancies, manual-review backlog, outbox lag, and balance drift',
  })
  @ApiOkResponse({
    description: 'Current database-backed operational counters',
    type: InternalMetricsResponseDto,
  })
  @ApiErrorResponses(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  getMetrics(): Promise<InternalMetricsResponseDto> {
    return this._internalOpsService.getMetrics();
  }
}
