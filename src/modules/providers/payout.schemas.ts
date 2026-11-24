import { z } from 'zod';

export const payoutAcceptedSchema = z.object({
  trackingId: z.string().nullish(),
  id: z.string().nullish(),
});

export const payoutErrorSchema = z.object({
  reason: z.string().nullish(),
  message: z.string().nullish(),
});

export const payoutInquirySchema = z.object({
  status: z.enum([
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'RETURNED',
    'REVERSED',
  ]),
  trackingId: z.string().nullish(),
  refId: z.string().nullish(),
  reason: z.string().nullish(),
  failureReason: z.string().nullish(),
  amount: z.union([z.string(), z.number()]).nullish(),
  currency: z.string().nullish(),
});
