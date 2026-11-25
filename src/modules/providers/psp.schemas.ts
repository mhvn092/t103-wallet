import { z } from 'zod';
import { PspStatusValue } from '../../common/enums/domain.enums.js';

export const pspCreatePaymentResponseSchema = z.object({
  token: z.string().min(1),
  paymentUrl: z.string().min(1),
  expiresAt: z.string().nullish(),
});

export const pspPaymentStatusSchema = z.object({
  status: z.enum(PspStatusValue),
  amount: z.union([z.string(), z.number()]).nullish(),
  refId: z.string().nullish(),
  orderId: z.string().nullish(),
});

export const pspVerifyResponseSchema = z.object({
  code: z.number().nullish(),
  status: z.string().nullish(),
  amount: z.union([z.string(), z.number()]).nullish(),
  refId: z.string().nullish(),
  message: z.string().nullish(),
});
