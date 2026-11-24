import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { ReconciliationController } from './reconciliation.controller.js';
import { ReconciliationService } from './reconciliation.service.js';

@Module({
  imports: [DatabaseModule, ProvidersModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
})
export class ReconciliationModule {}
