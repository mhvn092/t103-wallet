import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator.js';
import {
  IdempotencyRequestHash,
  IdempotentRoute,
  RequireIdempotencyKey,
} from '../idempotency/idempotency.decorator.js';
import { IdempotencyPreCheckGuard } from '../idempotency/idempotency.guard.js';
import { DepositService } from './deposit.service.js';
import { DepositCreateDto } from './dto/deposit-create.dto.js';
import { DepositPspCallbackDto } from './dto/deposit-psp-callback.dto.js';
import {
  DepositCallbackAckDto,
  DepositCreateResponseDto,
  DepositDetailResponseDto,
} from './dto/deposit-response.dto.js';

import {
  WalletAccessGuard,
  WalletPrincipal,
} from '../wallet/wallet-access.guard.js';

@Controller()
@ApiTags('Deposits & PSP Webhooks')
export class DepositController {
  constructor(private readonly _depositService: DepositService) {}

  @Post('deposits')
  @UseGuards(WalletAccessGuard, IdempotencyPreCheckGuard)
  @IdempotentRoute('POST:/deposits', { userField: 'userId' })
  @ApiHeader({ name: 'X-Wallet-Gateway-Key', required: false })
  @ApiHeader({ name: 'X-Wallet-User-Id', required: false })
  @ApiOperation({ summary: 'Initiate an IRT PSP deposit' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({
    description: 'Deposit initiated and PSP payment link created',
    type: DepositCreateResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  async initiate(
    @RequireIdempotencyKey() idempotencyKey: string,
    @IdempotencyRequestHash() requestHash: string | undefined,
    @Body() dto: DepositCreateDto,
  ): Promise<DepositCreateResponseDto> {
    const result = await this._depositService.initiateDeposit({
      idempotencyKey,
      requestHash,
      dto,
    });
    return result.body;
  }

  @Get('deposits/:id')
  @UseGuards(WalletAccessGuard)
  @ApiHeader({ name: 'X-Wallet-Gateway-Key', required: false })
  @ApiHeader({ name: 'X-Wallet-User-Id', required: false })
  @ApiOperation({ summary: 'Get deposit details and settlement status' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    description: 'Deposit record',
    type: DepositDetailResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  getDeposit(
    @Param('id') id: string,
    @WalletPrincipal() userId?: string,
  ): Promise<DepositDetailResponseDto> {
    return this._depositService.getDeposit(id, userId);
  }

  @Post('webhooks/psp/callback')
  @ApiOperation({
    summary: 'Unsigned PSP wake-up callback (verifies via PSP API)',
  })
  @ApiBody({ type: DepositPspCallbackDto })
  @ApiOkResponse({
    description: 'Callback acknowledged',
    type: DepositCallbackAckDto,
  })
  @ApiErrorResponses(HttpStatus.BAD_REQUEST)
  @HttpCode(HttpStatus.OK)
  handleCallback(@Req() req: Request): Promise<DepositCallbackAckDto> {
    return this._depositService.handlePspCallback(req.body as unknown);
  }
}
