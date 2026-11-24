import { ApiProperty } from '@nestjs/swagger';

export class HealthLivenessResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: string;

  @ApiProperty({ example: '2026-11-24T09:45:00.000Z' })
  timestamp!: string;
}

export class HealthReadinessResponseDto {
  @ApiProperty({ example: 'ready' })
  status!: string;

  @ApiProperty({ example: 'ok' })
  database!: string;

  @ApiProperty({ example: '2026-11-24T09:45:00.000Z' })
  timestamp!: string;
}
