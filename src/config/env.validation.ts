import { z } from 'zod';

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://t103:t103_secret@localhost:5432/t103_wallet'),
  RABBITMQ_URL: z.string().min(1).default('amqp://guest:guest@localhost:5672'),
  PSP_BASE_URL: z.string().url().default('http://localhost:8080'),
  PAYOUT_BASE_URL: z.string().url().default('http://localhost:8080'),
  WEBHOOK_SECRET: z.string().min(1).default('hamtapay-sim-secret'),
  INTERNAL_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  INTERNAL_ALLOWED_IPS: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  MIN_WITHDRAWAL_IRT: z.string().regex(/^[1-9]\d*$/).default('100000'),
  MIN_WITHDRAWAL_USDT: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
    .default('10'),
  USDT_WITHDRAWAL_FEE: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
    .default('1'),
  DAILY_LIMIT_IRT: z.string().regex(/^[1-9]\d*$/).default('200000000'),
  USDT_IRT_RATE: z.string().regex(/^[1-9]\d*$/).default('60000'),
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
  return envSchema.parse(config);
}
