import { ApiProperty } from '@nestjs/swagger';
import { WithdrawalStatus } from '../../../common/enums/domain.enums.js';
import { CURRENCIES, type Currency } from '../../../common/utils/money.util.js';

export class WithdrawalResponseDto {
  @ApiProperty({ format: 'uuid' })
  withdrawalId!: string;

  @ApiProperty({ example: 'user_1' })
  userId!: string;

  @ApiProperty({ enum: CURRENCIES, example: 'IRT' })
  currency!: Currency;

  @ApiProperty({ example: '250000' })
  amount!: string;

  @ApiProperty({ example: '0' })
  fee!: string;

  @ApiProperty({
    enum: WithdrawalStatus,
  })
  status!: WithdrawalStatus;

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
    enum: WithdrawalStatus,
    example: WithdrawalStatus.SUCCEEDED,
    required: false,
  })
  status?: WithdrawalStatus;
}
