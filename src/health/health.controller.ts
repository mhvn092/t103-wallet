import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service.js';

@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  @ApiOperation({ summary: 'Service liveness check' })
  @ApiResponse({ status: 200, description: 'Service is live' })
  checkLiveness() {
    return this.healthService.getLiveness();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Service readiness check (verifies PostgreSQL)' })
  @ApiResponse({ status: 200, description: 'Service and PostgreSQL are ready' })
  checkReadiness() {
    return this.healthService.getReadiness();
  }
}
