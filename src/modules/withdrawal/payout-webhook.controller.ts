import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator.js';
import { WithdrawalPayoutWebhookDto } from './dto/withdrawal-payout-webhook.dto.js';
import { WithdrawalWebhookAckDto } from './dto/withdrawal-response.dto.js';
import { WithdrawalService } from './withdrawal.service.js';

@Controller('webhooks/payout')
@ApiTags('Payout Webhooks')
export class PayoutWebhookController {
  constructor(private readonly _withdrawalService: WithdrawalService) {}

  @Post()
  @ApiOperation({
    summary: 'HMAC-SHA256 signed payout provider webhook callback',
  })
  @ApiHeader({ name: 'x-signature', required: true })
  @ApiBody({ type: WithdrawalPayoutWebhookDto })
  @ApiOkResponse({
    description: 'Webhook verified and processed',
    type: WithdrawalWebhookAckDto,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  @HttpCode(HttpStatus.OK)
  handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signatureHeader: string | undefined,
  ): Promise<WithdrawalWebhookAckDto> {
    return this._withdrawalService.handlePayoutWebhook({
      rawBody: req.rawBody,
      signatureHeader,
    });
  }
}
