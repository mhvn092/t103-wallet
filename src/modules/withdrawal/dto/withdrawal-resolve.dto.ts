import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TrimString } from '../../../common/decorators/trim-string.decorator.js';
import { WithdrawalOpsOutcomeEnum } from '../../../common/enums/withdrawal.enums.js';

export class WithdrawalResolveDto {
  @ApiProperty({
    enum: WithdrawalOpsOutcomeEnum,
    example: WithdrawalOpsOutcomeEnum.SUCCEEDED,
  })
  @IsEnum(WithdrawalOpsOutcomeEnum)
  outcome!: WithdrawalOpsOutcomeEnum;

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
