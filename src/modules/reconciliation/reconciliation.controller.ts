import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator.js';
import { ReconciliationResponseDto } from './dto/reconciliation-response.dto.js';
import { ReconciliationRunDto } from './dto/reconciliation-run.dto.js';
import { ReconciliationService } from './reconciliation.service.js';

@Controller('reconciliation')
@ApiTags('Reconciliation')
export class ReconciliationController {
  constructor(private readonly _reconciliationService: ReconciliationService) {}

  @Post('run')
  @ApiOperation({
    summary:
      'Run read-only daily settlement reconciliation against PSP CSV report',
  })
  @ApiOkResponse({
    description: 'Reconciliation report with matched counts and mismatches',
    type: ReconciliationResponseDto,
  })
  @ApiErrorResponses(HttpStatus.BAD_REQUEST, HttpStatus.SERVICE_UNAVAILABLE)
  @HttpCode(HttpStatus.OK)
  run(@Body() dto: ReconciliationRunDto): Promise<ReconciliationResponseDto> {
    return this._reconciliationService.runReconciliation(dto.date);
  }
}
