import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator.js';
import {
  HealthLivenessResponseDto,
  HealthReadinessResponseDto,
} from './dto/health-response.dto.js';
import { HealthService } from './health.service.js';

@Controller()
@ApiTags('Health')
export class HealthController {
  constructor(private readonly _healthService: HealthService) {}

  @Get('health')
  @ApiOperation({ summary: 'Service liveness check' })
  @ApiOkResponse({
    description: 'Service process and event loop are live',
    type: HealthLivenessResponseDto,
  })
  checkLiveness(): HealthLivenessResponseDto {
    return this._healthService.getLiveness();
  }

  @Get('health/liveness')
  @ApiOperation({ summary: 'Kubernetes liveness probe' })
  @ApiOkResponse({
    description: 'Service process and event loop are live',
    type: HealthLivenessResponseDto,
  })
  checkKubernetesLiveness(): HealthLivenessResponseDto {
    return this._healthService.getLiveness();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Service readiness check (verifies PostgreSQL)' })
  @ApiOkResponse({
    description: 'Service and PostgreSQL are ready',
    type: HealthReadinessResponseDto,
  })
  @ApiErrorResponses(HttpStatus.SERVICE_UNAVAILABLE)
  checkReadiness(): Promise<HealthReadinessResponseDto> {
    return this._healthService.getReadiness();
  }

  @Get('health/readiness')
  @ApiOperation({ summary: 'Kubernetes readiness probe (verifies PostgreSQL)' })
  @ApiOkResponse({
    description: 'Service and PostgreSQL are ready',
    type: HealthReadinessResponseDto,
  })
  @ApiErrorResponses(HttpStatus.SERVICE_UNAVAILABLE)
  checkKubernetesReadiness(): Promise<HealthReadinessResponseDto> {
    return this._healthService.getReadiness();
  }
}
