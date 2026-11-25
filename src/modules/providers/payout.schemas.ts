import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PayoutStatusValueEnum } from '../../common/enums/provider.enums.js';
import { IsStringOrNumber } from '../../common/utils/parse-validated.util.js';

export class PayoutAcceptedDto {
  @IsOptional()
  @IsString()
  trackingId?: string | null;

  @IsOptional()
  @IsString()
  id?: string | null;
}

export class PayoutErrorDto {
  @IsOptional()
  @IsString()
  reason?: string | null;

  @IsOptional()
  @IsString()
  error?: string | null;
}

export class PayoutInquiryDto {
  @IsEnum(PayoutStatusValueEnum)
  status!: PayoutStatusValueEnum;

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
