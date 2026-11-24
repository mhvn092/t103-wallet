import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../config/env.validation.js';

@Injectable()
export class HealthService {
  constructor(private readonly config: ConfigService<EnvConfig, true>) {}

  getStatus() {
    return {
      status: 'ok',
      environment: this.config.get('NODE_ENV', { infer: true }),
      timestamp: new Date().toISOString(),
    };
  }
}
