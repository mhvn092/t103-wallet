import {
  BeforeApplicationShutdown,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/errors/domain.exception.js';
import { ErrorCode } from '../common/errors/error-codes.js';
import type { EnvConfig } from '../config/env.validation.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  HealthLivenessResponseDto,
  HealthReadinessResponseDto,
} from './dto/health-response.dto.js';

@Injectable()
export class HealthService implements BeforeApplicationShutdown {
  constructor(
    private readonly _configService: ConfigService<EnvConfig, true>,
    private readonly _databaseService: DatabaseService,
  ) {}

  beforeApplicationShutdown(): void {
    this._isShuttingDown = true;
  }

  getLiveness(): HealthLivenessResponseDto {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness(): Promise<HealthReadinessResponseDto> {
    if (this._isShuttingDown) {
      throw new DomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.PROVIDER_UNAVAILABLE,
        'Service is shutting down',
      );
    }

    const timeoutMs = this._configService.get('READINESS_DB_TIMEOUT_MS', {
      infer: true,
    });
    try {
      await this._databaseService.ping(timeoutMs);
      return {
        status: 'ready',
        database: 'ok',
        timestamp: new Date().toISOString(),
      };
    } catch {
      throw new DomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.PROVIDER_UNAVAILABLE,
        'PostgreSQL database is not ready',
      );
    }
  }

  private _isShuttingDown = false;
}
