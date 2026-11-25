import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class PspCallbackPayloadDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  token?: string | null;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  orderId?: string | null;
}
