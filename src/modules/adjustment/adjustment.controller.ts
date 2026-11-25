import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
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
import { AdjustmentService } from './adjustment.service.js';
import { AdjustmentCreateDto } from './dto/adjustment-create.dto.js';
import { AdjustmentResponseDto } from './dto/adjustment-response.dto.js';
import { InternalOpsGuard } from './internal-ops.guard.js';

@Controller('internal/adjustments')
@UseGuards(InternalOpsGuard)
@ApiTags('Internal Operations')
export class AdjustmentController {
  constructor(private readonly _adjustmentService: AdjustmentService) {}

  @Post()
  @UseGuards(IdempotencyPreCheckGuard)
  @IdempotentRoute('POST:/internal/adjustments', { userField: 'userId' })
  @ApiOperation({
    summary: 'Manually credit a user wallet with double-entry audit trail',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Operator-Id', required: false })
  @ApiHeader({ name: 'X-Internal-Api-Key', required: false })
  @ApiCreatedResponse({
    description: 'Adjustment posted to ledger',
    type: AdjustmentResponseDto,
  })
  @ApiErrorResponses(...AUTHENTICATED_WRITE_ERROR_STATUSES)
  async create(
    @RequireIdempotencyKey() idempotencyKey: string,
    @IdempotencyRequestHash() requestHash: string | undefined,
    @Body() dto: AdjustmentCreateDto,
    @Headers('x-operator-id') rawOperatorId: string | undefined,
  ): Promise<AdjustmentResponseDto> {
    const operatorId = rawOperatorId?.trim() || 'system-ops';
    const result = await this._adjustmentService.createAdjustment({
      idempotencyKey,
      requestHash,
      dto,
      operatorId,
    });
    return result.body;
  }
}
