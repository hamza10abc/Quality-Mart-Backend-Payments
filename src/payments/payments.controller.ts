import { Controller, Logger, UseFilters } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { MicroserviceExceptionFilter } from '../common/filters/microservice-exception.filter';
import { PaymentsService } from './payments.service';
import type { PaymentPurpose } from './entities/payment.entity';
import type { RefundReason } from './entities/refund.entity';

/**
 * Internal TCP surface (Gateway and Order-MSV only — never exposed publicly
 * except through the Gateway's own guarded routes and the signed webhook).
 */
@Controller()
@UseFilters(MicroserviceExceptionFilter)
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly payments: PaymentsService) {}

  // ---- Store App (online checkout) ----

  @MessagePattern({ role: 'payments', cmd: 'create_checkout' })
  createCheckout(@Payload() data: { customerId: string; orderId: string }) {
    this.logger.log(`TCP create_checkout: order=${data?.orderId}`);
    return this.payments.createCheckout(data.customerId, data.orderId);
  }

  @MessagePattern({ role: 'payments', cmd: 'get_payment' })
  getPayment(@Payload() data: { paymentId: string }) {
    return this.payments.getPayment(data.paymentId);
  }

  @MessagePattern({ role: 'payments', cmd: 'get_by_order' })
  getByOrder(@Payload() data: { orderId: string; purpose?: PaymentPurpose }) {
    return this.payments.getByOrder(data.orderId, data.purpose);
  }

  // ---- Staff App (UPI QR at the door) ----

  @MessagePattern({ role: 'payments', cmd: 'create_pod_qr' })
  createPodQr(@Payload() data: { staffId: string; orderId: string }) {
    this.logger.log(`TCP create_pod_qr: order=${data?.orderId} staff=${data?.staffId}`);
    return this.payments.createPodQr(data.staffId, data.orderId);
  }

  @MessagePattern({ role: 'payments', cmd: 'cancel_pod_qr' })
  cancelPodQr(@Payload() data: { staffId: string; orderId: string }) {
    this.logger.log(`TCP cancel_pod_qr: order=${data?.orderId}`);
    return this.payments.cancelPodQr(data.staffId, data.orderId);
  }

  // ---- Order-MSV ----

  @MessagePattern({ role: 'payments', cmd: 'record_cash' })
  recordCash(
    @Payload() data: { orderId: string; customerId: string; staffId: string; amountMinor: number },
  ) {
    this.logger.log(`TCP record_cash: order=${data?.orderId}`);
    return this.payments.recordCash(data);
  }

  @MessagePattern({ role: 'payments', cmd: 'cancel_open_payments' })
  cancelOpenPayments(@Payload() data: { orderId: string }) {
    this.logger.log(`TCP cancel_open_payments: order=${data?.orderId}`);
    return this.payments.cancelOpenPayments(data.orderId);
  }

  // ---- Admin / later features ----

  @MessagePattern({ role: 'payments', cmd: 'refund' })
  refund(@Payload() data: { paymentId: string; reason: RefundReason; amountMinor?: number }) {
    this.logger.log(`TCP refund: payment=${data?.paymentId} (${data?.reason})`);
    return this.payments.requestRefund(data.paymentId, data.reason, data.amountMinor);
  }

  // ---- Provider webhooks (Gateway forwards the exact raw body + signature header) ----

  @MessagePattern({ role: 'payments', cmd: 'handle_webhook' })
  handleWebhook(@Payload() data: { provider: string; rawBody: string; signature: string }) {
    return this.payments.handleWebhook(data.provider, data.rawBody, data.signature);
  }
}
