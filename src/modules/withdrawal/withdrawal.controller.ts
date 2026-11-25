import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UserScopedDto } from '../../common/dto/user-scoped.dto.js';
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
import { WithdrawalCreateDto } from './dto/withdrawal-create.dto.js';
import { WithdrawalResponseDto } from './dto/withdrawal-response.dto.js';
import { WithdrawalService } from './withdrawal.service.js';

import {
  WalletAccessGuard,
  WalletPrincipal,
} from '../wallet/wallet-access.guard.js';

@Controller('withdrawals')
@UseGuards(WalletAccessGuard)
@ApiHeader({ name: 'X-Wallet-Gateway-Key', required: false })
@ApiHeader({ name: 'X-Wallet-User-Id', required: false })
@ApiTags('Withdrawals')
export class WithdrawalController {
  constructor(private readonly _withdrawalService: WithdrawalService) {}

  @Post()
  @UseGuards(IdempotencyPreCheckGuard)
  @IdempotentRoute('POST:/withdrawals', { userField: 'userId' })
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
    ...AUTHENTICATED_WRITE_ERROR_STATUSES,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  async create(
    @RequireIdempotencyKey() idempotencyKey: string,
    @IdempotencyRequestHash() requestHash: string | undefined,
    @Body() dto: WithdrawalCreateDto,
  ): Promise<WithdrawalResponseDto> {
    const result = await this._withdrawalService.createWithdrawal({
      idempotencyKey,
      requestHash,
      dto,
    });
    return result.body;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get withdrawal status and metadata' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    description: 'Withdrawal details',
    type: WithdrawalResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  getWithdrawal(
    @Param('id') id: string,
    @WalletPrincipal() userId?: string,
  ): Promise<WithdrawalResponseDto> {
    return this._withdrawalService.getWithdrawal(id, userId);
  }

  @Post(':id/cancel')
  @UseGuards(IdempotencyPreCheckGuard)
  @IdempotentRoute('POST:/withdrawals/:id/cancel', {
    includeParam: 'id',
    userField: 'userId',
    excludeUserFromHash: true,
  })
  @ApiOperation({
    summary: 'Cancel a withdrawal strictly while in PENDING_DISPATCH',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    description: 'Withdrawal cancelled and locked funds released',
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
  async cancelWithdrawal(
    @Param('id') id: string,
    @Body() dto: UserScopedDto,
    @RequireIdempotencyKey() idempotencyKey: string,
    @IdempotencyRequestHash() requestHash: string | undefined,
  ): Promise<WithdrawalResponseDto> {
    const result = await this._withdrawalService.cancelWithdrawal({
      withdrawalId: id,
      userId: dto.userId,
      idempotencyKey,
      requestHash,
    });
    return result.body;
  }
}
