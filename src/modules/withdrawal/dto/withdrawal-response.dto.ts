import { ApiProperty } from '@nestjs/swagger';
import { WithdrawalStatusEnum } from '../../../common/enums/withdrawal.enums.js';
import {
  CURRENCIES,
  type CurrencyEnum,
} from '../../../common/enums/currency.enum.js';

export class WithdrawalResponseDto {
  @ApiProperty({ format: 'uuid' })
  withdrawalId!: string;

  @ApiProperty({ example: 'user_1' })
  userId!: string;

  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  currency!: CurrencyEnum;

  @ApiProperty({ example: '250000' })
  amount!: string;

  @ApiProperty({ example: '0' })
  fee!: string;

  @ApiProperty({
    enum: WithdrawalStatusEnum,
  })
  status!: WithdrawalStatusEnum;

  @ApiProperty({ example: 'IR062960000000100324200001' })
  destination!: string;

  @ApiProperty({ example: 'wd_019abc...' })
  providerRequestId!: string;

  @ApiProperty({ type: String, nullable: true })
  providerRefId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  failureReason!: string | null;

  @ApiProperty({ example: false })
  lateSuccessConflict!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class WithdrawalWebhookAckDto {
  @ApiProperty({ example: true })
  received!: boolean;

  @ApiProperty({ format: 'uuid', required: false })
  withdrawalId?: string;

  @ApiProperty({
    enum: WithdrawalStatusEnum,
    example: WithdrawalStatusEnum.SUCCEEDED,
    required: false,
  })
  status?: WithdrawalStatusEnum;
}
