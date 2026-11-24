import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { TrimString } from '../../../common/decorators/trim-string.decorator.js';
import { UserScopedDto } from '../../../common/dto/user-scoped.dto.js';

export class DepositCreateDto extends UserScopedDto {
  @ApiProperty({
    description: 'Requested deposit amount in IRT (integer string)',
    example: '500000',
  })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  amount!: string;
}
