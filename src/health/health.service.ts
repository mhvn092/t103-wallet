import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/errors/domain.exception.js';
import { ErrorCode } from '../common/errors/error-codes.js';
import type { EnvConfig } from '../config/env.validation.js';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class HealthService {
  constructor(
    private readonly config: ConfigService<EnvConfig, true>,
    private readonly db: DatabaseService,
  ) {}

  getLiveness() {
    return {
      status: 'ok',
      environment: this.config.get('NODE_ENV', { infer: true }),
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness() {
    try {
      await this.db.ping();
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
}
