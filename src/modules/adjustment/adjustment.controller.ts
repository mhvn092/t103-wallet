import {
  Body,
  Controller,
  Headers,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RequireIdempotencyKey } from '../idempotency/idempotency.decorator.js';
import { CreateAdjustmentDto } from './adjustment.dto.js';
import { AdjustmentService } from './adjustment.service.js';
import { InternalOpsGuard } from './internal-ops.guard.js';

@ApiTags('Internal Operations')
@Controller('internal/adjustments')
@UseGuards(InternalOpsGuard)
export class AdjustmentController {
  constructor(private readonly adjustmentService: AdjustmentService) {}

  @Post()
  @ApiOperation({
    summary: 'Manually credit a user wallet with double-entry audit trail',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Operator-Id', required: false })
  @ApiHeader({ name: 'X-Internal-Api-Key', required: false })
  @ApiResponse({ status: 201, description: 'Adjustment posted to ledger' })
  async create(
    @RequireIdempotencyKey() idempotencyKey: string,
    @Body() dto: CreateAdjustmentDto,
    @Headers('x-operator-id') rawOperatorId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const operatorId = rawOperatorId?.trim() || 'system-ops';
    const result = await this.adjustmentService.createAdjustment({
      idempotencyKey,
      dto,
      operatorId,
    });
    res.status(result.statusCode);
    return result.body;
  }
}
