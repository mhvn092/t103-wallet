import { z } from 'zod';
import { PayoutStatusValue } from '../../common/enums/domain.enums.js';

export const payoutAcceptedSchema = z.object({
  trackingId: z.string().nullish(),
  id: z.string().nullish(),
});

export const payoutErrorSchema = z.object({
  reason: z.string().nullish(),
  error: z.string().nullish(),
});

export const payoutInquirySchema = z.object({
  status: z.enum(PayoutStatusValue),
  trackingId: z.string().nullish(),
  refId: z.string().nullish(),
  reason: z.string().nullish(),
  failureReason: z.string().nullish(),
  amount: z.union([z.string(), z.number()]).nullish(),
  currency: z.string().nullish(),
});
