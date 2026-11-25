import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { emptyToUndefined } from '../common/utils/string-normalizer.util.js';

class EnvironmentDto {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsIn(['local', 'dev', 'stage', 'production'])
  APP_ENV: 'local' | 'dev' | 'stage' | 'production' = 'local';

  @IsIn(['true', 'false'])
  SWAGGER_ENABLED: 'true' | 'false' = 'false';

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  APP_PUBLIC_URL: string = 'http://localhost:3000';

  @IsString()
  @Matches(/^postgres(?:ql)?:\/\//i)
  DATABASE_URI!: string;

  @IsOptional()
  @IsString()
  @Matches(/^postgres(?:ql)?:\/\//i)
  MIGRATION_DATABASE_URI?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z_][a-z0-9_]{0,62}$/)
  POSTGRES_APP_USER?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  POSTGRES_APP_PASSWORD?: string;

  @IsString()
  @Matches(/^amqps?:\/\//i)
  RABBITMQ_URI!: string;

  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  PSP_BASE_URL: string = 'http://localhost:8080';

  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  PAYOUT_BASE_URL: string = 'http://localhost:8080';

  @IsString()
  @MinLength(1)
  WEBHOOK_SECRET!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  INTERNAL_API_KEY?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  WALLET_GATEWAY_KEY?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  INTERNAL_ALLOWED_IPS?: string;

  @IsIn(['true', 'false'])
  ALLOW_UNAUTHENTICATED_INTERNAL_OPS: 'true' | 'false' = 'false';

  @IsInt()
  @Min(100)
  @Max(10000)
  READINESS_DB_TIMEOUT_MS: number = 2000;

  @IsInt()
  @Min(1000)
  @Max(86400000)
  WD_MANUAL_REVIEW_SLA_MS: number = 1800000;

  @IsString()
  @Matches(/^[1-9]\d*$/)
  MIN_WITHDRAWAL_IRT: string = '100000';

  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
  MIN_WITHDRAWAL_USDT: string = '10';

  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
  USDT_WITHDRAWAL_FEE: string = '1';

  @IsString()
  @Matches(/^[1-9]\d*$/)
  DAILY_LIMIT_IRT: string = '200000000';

  @IsString()
  @Matches(/^[1-9]\d*$/)
  USDT_IRT_RATE: string = '60000';

  @IsInt()
  @Min(1)
  DEPOSIT_TTL_SECONDS: number = 1800;

  @IsInt()
  @Min(0)
  @Max(86400000)
  DEPOSIT_EXPIRY_GRACE_MS: number = 900000;

  @IsString()
  @IsTimeZone()
  RECONCILIATION_TZ: string = 'UTC';

  @IsOptional()
  @IsString()
  @Matches(/^(?:true|false|loopback|\d+)$/i)
  TRUST_PROXY?: string;

  @IsInt()
  @Min(1000)
  @Max(86400000)
  RETENTION_CLEANUP_INTERVAL_MS: number = 300000;

  @IsInt()
  @Min(1000)
  @Max(86400000)
  DRIFT_AUDIT_INTERVAL_MS: number = 60000;

  @IsInt()
  @Min(500)
  @Max(60000)
  PROVIDER_HTTP_TIMEOUT_MS: number = 10000;

  @IsInt()
  @Min(50)
  @Max(60000)
  WORKER_POLL_INTERVAL_MS: number = 1000;

  @IsIn(['true', 'false'])
  WORKERS_ENABLED: 'true' | 'false' = 'true';
}

export type EnvConfig = Omit<
  EnvironmentDto,
  'SWAGGER_ENABLED' | 'ALLOW_UNAUTHENTICATED_INTERNAL_OPS' | 'WORKERS_ENABLED'
> & {
  SWAGGER_ENABLED: boolean;
  ALLOW_UNAUTHENTICATED_INTERNAL_OPS: boolean;
  WORKERS_ENABLED: boolean;
};

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const values: Record<string, unknown> = {
    ...config,
    APP_ENV:
      config.APP_ENV ??
      (config.NODE_ENV === 'production' ? 'production' : 'local'),
  };
  for (const key of [
    'PORT',
    'READINESS_DB_TIMEOUT_MS',
    'WD_MANUAL_REVIEW_SLA_MS',
    'DEPOSIT_TTL_SECONDS',
    'DEPOSIT_EXPIRY_GRACE_MS',
    'RETENTION_CLEANUP_INTERVAL_MS',
    'DRIFT_AUDIT_INTERVAL_MS',
    'PROVIDER_HTTP_TIMEOUT_MS',
    'WORKER_POLL_INTERVAL_MS',
  ]) {
    if (values[key] !== undefined) {
      values[key] = Number(values[key]);
    }
  }
  for (const key of [
    'MIGRATION_DATABASE_URI',
    'POSTGRES_APP_USER',
    'POSTGRES_APP_PASSWORD',
    'INTERNAL_API_KEY',
    'WALLET_GATEWAY_KEY',
    'INTERNAL_ALLOWED_IPS',
    'TRUST_PROXY',
  ]) {
    values[key] = emptyToUndefined(values[key]);
  }
  const dto = plainToInstance(EnvironmentDto, values, {
    exposeUnsetFields: false,
  });
  const errors = validateSync(dto, { whitelist: true });
  if (errors.length > 0) {
    const details = errors
      .flatMap((error) =>
        Object.values(error.constraints ?? {}).map(
          (message) => `${error.property}: ${message}`,
        ),
      )
      .join('; ');
    throw new Error(`Environment validation failed: ${details}`);
  }
  const validated = Object.fromEntries(Object.entries(dto)) as Omit<
    EnvConfig,
    'SWAGGER_ENABLED' | 'ALLOW_UNAUTHENTICATED_INTERNAL_OPS' | 'WORKERS_ENABLED'
  >;
  return {
    ...validated,
    SWAGGER_ENABLED: dto.SWAGGER_ENABLED === 'true',
    ALLOW_UNAUTHENTICATED_INTERNAL_OPS:
      dto.ALLOW_UNAUTHENTICATED_INTERNAL_OPS === 'true',
    WORKERS_ENABLED: dto.WORKERS_ENABLED === 'true',
  };
}
