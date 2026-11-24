import { ApiPropertyOptional } from '@nestjs/swagger';

export class DepositPspCallbackDto {
  @ApiPropertyOptional({ example: 'psp_tok_abc123' })
  token?: string;

  @ApiPropertyOptional({ example: 'dep_019abc...' })
  orderId?: string;

  @ApiPropertyOptional({ example: 'OK' })
  status?: string;
}
