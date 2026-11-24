import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { TrimString } from '../decorators/trim-string.decorator.js';

export class UserScopedDto {
  @ApiProperty({ example: 'user_1' })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId!: string;
}
