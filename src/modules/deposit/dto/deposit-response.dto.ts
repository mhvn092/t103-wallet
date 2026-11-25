import { ApiProperty } from '@nestjs/swagger';
import { DepositStatus } from '../../../common/enums/domain.enums.js';

export class DepositCreateResponseDto {
  @ApiProperty({ format: 'uuid' })
  depositId!: string;

  @ApiProperty({
    enum: DepositStatus,
    example: DepositStatus.AWAITING_PAYMENT,
  })
  status!: DepositStatus;

  @ApiProperty({ example: 'http://localhost:8080/psp/pay/tok_123' })
  paymentUrl!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  expiresAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class DepositDetailResponseDto {
  @ApiProperty({ format: 'uuid' })
  depositId!: string;

  @ApiProperty({ example: 'user_1' })
  userId!: string;

  @ApiProperty({ example: '500000' })
  requestedAmount!: string;

  @ApiProperty({ type: String, nullable: true, example: '500000' })
  verifiedAmount!: string | null;

  @ApiProperty({ example: false })
  amountMismatch!: boolean;

  @ApiProperty({ type: String, nullable: true })
  pspToken!: string | null;

  @ApiProperty({ type: String, nullable: true })
  pspRefId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  paymentUrl!: string | null;

  @ApiProperty({
    enum: DepositStatus,
  })
  status!: DepositStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  verifiedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class DepositCallbackAckDto {
  @ApiProperty({ example: true })
  received!: boolean;

  @ApiProperty({ format: 'uuid', required: false })
  depositId?: string;

  @ApiProperty({
    enum: DepositStatus,
    example: DepositStatus.SUCCEEDED,
    required: false,
  })
  status?: DepositStatus;
}
