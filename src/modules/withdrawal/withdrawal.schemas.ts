import { z } from 'zod';

export const payoutWebhookPayloadSchema = z.object({
  requestId: z.string().min(1).nullish(),
  status: z
    .enum([
      'PENDING',
      'PROCESSING',
      'SUCCEEDED',
      'FAILED',
      'RETURNED',
      'REVERSED',
    ])
    .nullish(),
  trackingId: z.string().nullish(),
  refId: z.string().nullish(),
  reason: z.string().nullish(),
  failureReason: z.string().nullish(),
  amount: z.union([z.string(), z.number()]).nullish(),
  currency: z.string().nullish(),
});
