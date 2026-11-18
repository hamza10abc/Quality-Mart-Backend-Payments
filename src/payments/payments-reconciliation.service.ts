import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentsService } from './payments.service';

/**
 * Safety net behind the webhooks:
 *  1. retries "tell Order-MSV it was paid" for succeeded payments whose first attempt failed;
 *  2. re-reads provider payments stuck in flight, in case a webhook never arrived.
 * Both are idempotent, and claiming uses a DB lease so multiple instances don't collide.
 */
@Injectable()
export class PaymentsReconciliationService {
  private readonly logger = new Logger(PaymentsReconciliationService.name);
  private running = false;

  constructor(private readonly payments: PaymentsService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async run(): Promise<void> {
    if (this.running) return; // never overlap with a slow previous pass
    this.running = true;
    try {
      for (const payment of await this.payments.claimPendingOrderSyncs()) {
        await this.payments.syncOrder(payment).catch((err) =>
          this.logger.error(`Order sync failed for ${payment.id}: ${err.message}`),
        );
      }
      for (const payment of await this.payments.findStaleInFlight()) {
        await this.payments.reconcileOne(payment).catch((err) =>
          this.logger.error(`Provider re-read failed for ${payment.id}: ${err.message}`),
        );
      }
    } catch (err: any) {
      this.logger.error(`Reconciliation pass failed: ${err.message}`, err.stack);
    } finally {
      this.running = false;
    }
  }
}
