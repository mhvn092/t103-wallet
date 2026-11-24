import { ApiProperty } from '@nestjs/swagger';

class ReconciliationSummaryDto {
  @ApiProperty({ example: 12 })
  csvDepositCount!: number;

  @ApiProperty({ example: 11 })
  localDepositCount!: number;

  @ApiProperty({ example: 10 })
  matchedCount!: number;

  @ApiProperty({ example: 2 })
  mismatchCount!: number;

  @ApiProperty({ example: 1 })
  duplicateCsvRowsIgnored!: number;
}

export class ReconciliationMismatchDto {
  @ApiProperty({
    enum: ['MISSING_IN_LOCAL', 'MISSING_IN_CSV', 'AMOUNT_MISMATCH'],
    example: 'AMOUNT_MISMATCH',
  })
  type!: 'MISSING_IN_LOCAL' | 'MISSING_IN_CSV' | 'AMOUNT_MISMATCH';

  @ApiProperty({ example: '1382264189' })
  reference!: string;

  @ApiProperty({ type: String, nullable: true, example: '50000' })
  csvAmount!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '60000' })
  localAmount!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  depositId!: string | null;

  @ApiProperty({ example: 'Verified local IRT differs from PSP CSV IRT' })
  details!: string;
}

export class ReconciliationResponseDto {
  @ApiProperty({ example: '2026-11-24' })
  date!: string;

  @ApiProperty({ type: ReconciliationSummaryDto })
  summary!: ReconciliationSummaryDto;

  @ApiProperty({ type: [ReconciliationMismatchDto] })
  mismatches!: ReconciliationMismatchDto[];
}
