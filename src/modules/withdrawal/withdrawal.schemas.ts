import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PayoutStatusValueEnum } from '../../common/enums/provider.enums.js';
import { IsStringOrNumber } from '../../common/utils/parse-validated.util.js';

export class PayoutWebhookPayloadDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  requestId?: string | null;

  @IsOptional()
  @IsEnum(PayoutStatusValueEnum)
  status?: PayoutStatusValueEnum | null;

  @IsOptional()
  @IsString()
  trackingId?: string | null;

  @IsOptional()
  @IsString()
  refId?: string | null;

  @IsOptional()
  @IsString()
  reason?: string | null;

  @IsOptional()
  @IsString()
  failureReason?: string | null;

  @IsOptional()
  @IsStringOrNumber()
  amount?: string | number | null;

  @IsOptional()
  @IsString()
  currency?: string | null;
}
