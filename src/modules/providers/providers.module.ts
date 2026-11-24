import { Module } from '@nestjs/common';
import { PayoutClient } from './payout.client.js';
import { PspClient } from './psp.client.js';

@Module({
  providers: [PspClient, PayoutClient],
  exports: [PspClient, PayoutClient],
})
export class ProvidersModule {}
