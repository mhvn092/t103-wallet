import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { TrimString } from './trim-string.decorator.js';

export function UserIdField(
  description: string,
  example = 'user_1',
): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ description, example }),
    TrimString(),
    IsString(),
    IsNotEmpty(),
    MaxLength(128),
  );
}
