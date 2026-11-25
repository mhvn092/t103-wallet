import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { PspStatusValueEnum } from '../../common/enums/provider.enums.js';
import { IsStringOrNumber } from '../../common/utils/parse-validated.util.js';

export class PspCreatePaymentResponseDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsString()
  @IsNotEmpty()
  paymentUrl!: string;

  @IsOptional()
  @IsString()
  expiresAt?: string | null;
}

export class PspPaymentStatusDto {
  @IsEnum(PspStatusValueEnum)
  status!: PspStatusValueEnum;

  @IsOptional()
  @IsStringOrNumber()
  amount?: string | number | null;

  @IsOptional()
  @IsString()
  refId?: string | null;

  @IsOptional()
  @IsString()
  orderId?: string | null;
}

export class PspVerifyResponseDto {
  @IsOptional()
  @IsNumber()
  code?: number | null;

  @IsOptional()
  @IsString()
  status?: string | null;

  @IsOptional()
  @IsStringOrNumber()
  amount?: string | number | null;

  @IsOptional()
  @IsString()
  refId?: string | null;

  @IsOptional()
  @IsString()
  message?: string | null;
}
