import { ApiProperty } from '@nestjs/swagger';
import { ErrorCode } from '../errors/error-codes.js';

export class ErrorResponseDto {
  @ApiProperty({
    enum: Object.values(ErrorCode),
    example: ErrorCode.INVALID_REQUEST,
  })
  code!: string;

  @ApiProperty({ example: 'Validation failed' })
  message!: string;
}
