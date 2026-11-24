import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WithdrawalPayoutWebhookDto {
  @ApiProperty({ example: 'wd_019abc...' })
  requestId!: string;

  @ApiProperty({
    enum: [
      'PENDING',
      'PROCESSING',
      'SUCCEEDED',
      'FAILED',
      'RETURNED',
      'REVERSED',
    ],
    example: 'SUCCEEDED',
  })
  status!: string;

  @ApiPropertyOptional({ example: 'TRK123456' })
  trackingId?: string;

  @ApiPropertyOptional({ example: 'REF998877' })
  refId?: string;

  @ApiPropertyOptional({ example: 'INVALID_IBAN' })
  reason?: string;

  @ApiPropertyOptional({ example: 'INVALID_IBAN' })
  failureReason?: string;

  @ApiPropertyOptional({ example: '2500000' })
  amount?: string | number;

  @ApiPropertyOptional({ example: 'IRR' })
  currency?: string;
}
