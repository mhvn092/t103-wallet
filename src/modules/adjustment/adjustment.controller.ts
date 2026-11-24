import {
  Body,
  Controller,
  Headers,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator.js';
import { RequireIdempotencyKey } from '../idempotency/idempotency.decorator.js';
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
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  async create(
    @RequireIdempotencyKey() idempotencyKey: string,
    @Body() dto: AdjustmentCreateDto,
    @Headers('x-operator-id') rawOperatorId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdjustmentResponseDto> {
    const operatorId = rawOperatorId?.trim() || 'system-ops';
    const result = await this._adjustmentService.createAdjustment({
      idempotencyKey,
      dto,
      operatorId,
    });
    res.status(result.statusCode);
    return result.body;
  }
}
