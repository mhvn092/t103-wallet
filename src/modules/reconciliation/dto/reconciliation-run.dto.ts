import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { TrimString } from '../../../common/decorators/trim-string.decorator.js';

export class ReconciliationRunDto {
  @ApiProperty({
    description: 'Target settlement calendar date in YYYY-MM-DD',
    example: '2026-11-24',
  })
  @TrimString()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be in YYYY-MM-DD format',
  })
  date!: string;
}
