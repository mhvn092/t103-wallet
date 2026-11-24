import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
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
import type { Request, Response } from 'express';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator.js';
import { RequireIdempotencyKey } from '../idempotency/idempotency.decorator.js';
import { DepositService } from './deposit.service.js';
import { DepositCreateDto } from './dto/deposit-create.dto.js';
import { DepositPspCallbackDto } from './dto/deposit-psp-callback.dto.js';
import {
  DepositCallbackAckDto,
  DepositCreateResponseDto,
  DepositDetailResponseDto,
} from './dto/deposit-response.dto.js';

@Controller()
@ApiTags('Deposits & PSP Webhooks')
export class DepositController {
  constructor(private readonly _depositService: DepositService) {}

  @Post('deposits')
  @ApiOperation({ summary: 'Initiate an IRT PSP deposit' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({
    description: 'Deposit initiated and PSP payment link created',
    type: DepositCreateResponseDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  async initiate(
    @RequireIdempotencyKey() idempotencyKey: string,
    @Body() dto: DepositCreateDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DepositCreateResponseDto> {
    const result = await this._depositService.initiateDeposit({
      idempotencyKey,
      dto,
    });
    res.status(result.statusCode);
    return result.body;
  }

  @Get('deposits/:id')
  @ApiOperation({ summary: 'Get deposit details and settlement status' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    description: 'Deposit record',
    type: DepositDetailResponseDto,
  })
  @ApiErrorResponses(HttpStatus.BAD_REQUEST, HttpStatus.NOT_FOUND)
  getDeposit(@Param('id') id: string): Promise<DepositDetailResponseDto> {
    return this._depositService.getDeposit(id);
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
  @HttpCode(HttpStatus.OK)
  handleCallback(@Req() req: Request): Promise<DepositCallbackAckDto> {
    return this._depositService.handlePspCallback(req.body);
  }
}
