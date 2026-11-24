import { z } from 'zod';

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const httpUrlSchema = z.url().refine((value) => /^https?:\/\//i.test(value), {
  message: 'URL must use http:// or https:// scheme',
});

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  APP_ENV: z.enum(['local', 'dev', 'stage', 'production']).default('local'),
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_PUBLIC_URL: httpUrlSchema.default('http://localhost:3000'),
  DATABASE_URI: z
    .string()
    .min(1)
    .regex(
      /^postgres(?:ql)?:\/\//i,
      'DATABASE_URI must use postgres:// or postgresql:// scheme',
    ),
  RABBITMQ_URI: z
    .string()
    .min(1)
    .regex(/^amqps?:\/\//i, 'RABBITMQ_URI must use amqp:// or amqps:// scheme'),
  PSP_BASE_URL: httpUrlSchema.default('http://localhost:8080'),
  PAYOUT_BASE_URL: httpUrlSchema.default('http://localhost:8080'),
  WEBHOOK_SECRET: z.string().min(1),
  INTERNAL_API_KEY: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  INTERNAL_ALLOWED_IPS: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  READINESS_DB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(10000)
    .default(2000),
  WD_MANUAL_REVIEW_SLA_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(86_400_000)
    .default(1_800_000),
  MIN_WITHDRAWAL_IRT: z
    .string()
    .regex(/^[1-9]\d*$/)
    .default('100000'),
  MIN_WITHDRAWAL_USDT: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
    .default('10'),
  USDT_WITHDRAWAL_FEE: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
    .default('1'),
  DAILY_LIMIT_IRT: z
    .string()
    .regex(/^[1-9]\d*$/)
    .default('200000000'),
  USDT_IRT_RATE: z
    .string()
    .regex(/^[1-9]\d*$/)
    .default('60000'),
  DEPOSIT_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  PROVIDER_HTTP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(60000)
    .default(10000),
  WORKER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(60000)
    .default(1000),
  WORKERS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Environment validation failed: ${details}`);
  }
  return parsed.data;
}
