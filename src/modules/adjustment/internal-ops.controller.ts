import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator.js';
import {
  IdempotencyRequestHash,
  IdempotentRoute,
  RequireIdempotencyKey,
} from '../idempotency/idempotency.decorator.js';
import { IdempotencyPreCheckGuard } from '../idempotency/idempotency.guard.js';
import { InternalMetricsResponseDto } from './dto/internal-metrics-response.dto.js';
import { ReceivableSettleResponseDto } from './dto/receivable-settle-response.dto.js';
import { ReceivableSettleDto } from './dto/receivable-settle.dto.js';
import { WithdrawalsPauseResponseDto } from './dto/withdrawals-pause-response.dto.js';
import { WithdrawalsPauseDto } from './dto/withdrawals-pause.dto.js';
import { InternalOpsGuard } from './internal-ops.guard.js';
import { InternalOpsService } from './internal-ops.service.js';

@Controller('internal')
@UseGuards(InternalOpsGuard)
@ApiTags('Internal Operations')
@ApiHeader({ name: 'X-Internal-Api-Key', required: false })
export class InternalOpsController {
  constructor(private readonly _internalOpsService: InternalOpsService) {}

  @Post('receivables/settle')
  @UseGuards(IdempotencyPreCheckGuard)
  @IdempotentRoute('POST:/internal/receivables/settle', { userField: 'userId' })
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
  @HttpCode(HttpStatus.OK)
  async settleReceivable(
    @RequireIdempotencyKey() idempotencyKey: string,
    @IdempotencyRequestHash() requestHash: string | undefined,
    @Body() dto: ReceivableSettleDto,
    @Headers('x-operator-id') rawOperatorId: string | undefined,
  ): Promise<ReceivableSettleResponseDto> {
    const operatorId = rawOperatorId?.trim() || 'system-ops';
    const result = await this._internalOpsService.settleReceivable({
      idempotencyKey,
      requestHash,
      dto,
      operatorId,
    });
    return result.body;
  }

  @Post('controls/withdrawals-pause')
  @IdempotentRoute('POST:/internal/controls/withdrawals-pause')
  @UseGuards(IdempotencyPreCheckGuard)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
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
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  @HttpCode(HttpStatus.OK)
  async pauseWithdrawals(
    @RequireIdempotencyKey() idempotencyKey: string,
    @IdempotencyRequestHash() requestHash: string | undefined,
    @Body() dto: WithdrawalsPauseDto,
  ): Promise<WithdrawalsPauseResponseDto> {
    const result = await this._internalOpsService.updateWithdrawalPause({
      dto,
      idempotencyKey,
      requestHash,
    });
    return result.body;
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

  @Get('metrics/prometheus')
  @ApiOperation({
    summary:
      'Prometheus text exposition of wallet/ledger/outbox operational gauges',
  })
  @ApiProduces('text/plain')
  @ApiOkResponse({
    description: 'Prometheus text format 0.0.4 metrics',
    type: String,
  })
  @ApiErrorResponses(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getPrometheusMetrics(): Promise<string> {
    const metrics = await this._internalOpsService.getMetrics();
    return this._internalOpsService.formatPrometheusMetrics(metrics);
  }
}
