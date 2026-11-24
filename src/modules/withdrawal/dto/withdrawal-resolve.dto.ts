import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TrimString } from '../../../common/decorators/trim-string.decorator.js';

export class WithdrawalResolveDto {
  @ApiProperty({
    enum: ['SUCCEEDED', 'FAILED'],
    example: 'SUCCEEDED',
  })
  @IsIn(['SUCCEEDED', 'FAILED'])
  outcome!: 'SUCCEEDED' | 'FAILED';

  @ApiProperty({
    description: 'Audit reason for manual review resolution',
    example: 'Confirmed settled by bank operations desk',
  })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description: 'Optional external bank/blockchain reference ID',
    example: 'BANK-REF-OPS-101',
  })
  @IsOptional()
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  providerRefId?: string;
}
