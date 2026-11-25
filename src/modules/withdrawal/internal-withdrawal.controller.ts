import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { InternalOpsGuard } from '../adjustment/internal-ops.guard.js';
import {
  IdempotencyRequestHash,
  IdempotentRoute,
  RequireIdempotencyKey,
} from '../idempotency/idempotency.decorator.js';
import { IdempotencyPreCheckGuard } from '../idempotency/idempotency.guard.js';
import { WithdrawalResolveDto } from './dto/withdrawal-resolve.dto.js';
import { WithdrawalResponseDto } from './dto/withdrawal-response.dto.js';
import { WithdrawalService } from './withdrawal.service.js';

@Controller('internal/withdrawals')
@UseGuards(InternalOpsGuard)
@ApiTags('Internal Operations')
@ApiHeader({ name: 'X-Internal-Api-Key', required: false })
export class InternalWithdrawalController {
  constructor(private readonly _withdrawalService: WithdrawalService) {}

  @Post(':id/resolve')
  @UseGuards(IdempotencyPreCheckGuard)
  @IdempotentRoute('POST:/internal/withdrawals/:id/resolve', {
    includeParam: 'id',
  })
  @ApiOperation({
    summary:
      'Manually resolve a withdrawal in MANUAL_REVIEW as SUCCEEDED or FAILED',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Operator-Id', required: false })
  @ApiOkResponse({
    description: 'Withdrawal resolved cleanly in double-entry ledger',
    type: WithdrawalResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  @HttpCode(HttpStatus.OK)
  async resolveManualReview(
    @Param('id') id: string,
    @RequireIdempotencyKey() idempotencyKey: string,
    @IdempotencyRequestHash() requestHash: string | undefined,
    @Body() dto: WithdrawalResolveDto,
    @Headers('x-operator-id') rawOperatorId: string | undefined,
  ): Promise<WithdrawalResponseDto> {
    const operatorId = rawOperatorId?.trim() || 'system-ops';
    const result = await this._withdrawalService.resolveManualReview({
      withdrawalId: id,
      idempotencyKey,
      requestHash,
      dto,
      operatorId,
    });
    return result.body;
  }
}
