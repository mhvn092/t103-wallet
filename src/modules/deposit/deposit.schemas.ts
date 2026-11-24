import { z } from 'zod';

export const pspCallbackPayloadSchema = z.object({
  token: z.string().min(1).nullish(),
  orderId: z.string().min(1).nullish(),
});
