import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { firstValueFrom } from 'rxjs';
import { In, Not, Repository } from 'typeorm';
import { Payment, PaymentPurpose, PaymentStatus } from './entities/payment.entity';
import { PaymentAttempt } from './entities/payment-attempt.entity';
import { PaymentEvent } from './entities/payment-event.entity';
import { Refund, RefundReason } from './entities/refund.entity';
import { ProviderRegistry } from './providers/provider.registry';
import type {
  NormalizedWebhookEvent,
  ProviderPaymentSnapshot,
  ProviderRefundSnapshot,
} from './providers/payment-provider.interface';

/** What Order-MSV tells us about an order (see OrderSagaService.getPayable). */
interface Payable {
  orderId: string;
  orderNumber: string;
  customerId: string;
  status: string;
  paymentMethod: 'pod' | 'online';
  paymentStatus: 'pending' | 'paid';
  assignedStaffId: string | null;
  paymentConfirmedAt: string | null;
  totalMinor: number;
  customerName?: string;
  customerAddress?: { line1: string; city?: string; state?: string; country?: string };
}

export interface PaymentView {
  paymentId: string;
  orderId: string;
  customerId: string;
  purpose: PaymentPurpose;
  provider: string;
  method: string | null;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  amountRefundedMinor: number;
  /** Only on checkout create/resume: what the mobile payment sheet needs. */
  clientSecret?: string | null;
  /** UPI QR, while one is awaiting the customer. */
  qr?: { imageUrl: string; expiresAt: string; hostedInstructionsUrl: string } | null;
  lastError?: { code: string | null; message: string | null } | null;
}

const LIVE_ERR_PG_UNIQUE = '23505';
const SYNC_LEASE_MS = 30_000;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly instanceId = randomUUID();

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(PaymentAttempt) private readonly attempts: Repository<PaymentAttempt>,
    @InjectRepository(PaymentEvent) private readonly events: Repository<PaymentEvent>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @Inject('ORDER_SERVICE') private readonly orderClient: ClientProxy,
    private readonly registry: ProviderRegistry,
  ) {}

  // ───────────────────────── helpers ─────────────────────────

  private orderSend<T>(cmd: string, data: unknown): Promise<T> {
    return firstValueFrom(this.orderClient.send<T>({ role: 'order', cmd }, data));
  }

  private isUniqueViolation(err: any): boolean {
    return err?.code === LIVE_ERR_PG_UNIQUE || err?.driverError?.code === LIVE_ERR_PG_UNIQUE;
  }

  /** Order-MSV's exception filter crosses TCP as `{ response: { statusCode }, status }`. */
  private isConflict(err: any): boolean {
    return err?.status === 409 || err?.response?.statusCode === 409;
  }

  /** The single non-canceled payment for an order + purpose (DB-unique), if any. */
  private findLive(orderId: string, purpose: PaymentPurpose): Promise<Payment | null> {
    return this.payments.findOne({ where: { orderId, purpose, status: Not('canceled') } });
  }

  private toView(p: Payment, extra: Partial<PaymentView> = {}): PaymentView {
    const data = (p.providerData ?? {}) as Record<string, any>;
    const qrOpen =
      data.qrImageUrl && p.status !== 'succeeded' && p.status !== 'canceled' && p.status !== 'processing';
    return {
      paymentId: p.id,
      orderId: p.orderId,
      customerId: p.customerId,
      purpose: p.purpose,
      provider: p.provider,
      method: p.method,
      status: p.status,
      amountMinor: p.amountMinor,
      currency: p.currency,
      amountRefundedMinor: p.amountRefundedMinor,
      qr: qrOpen
        ? {
            imageUrl: data.qrImageUrl,
            expiresAt: data.qrExpiresAt,
            hostedInstructionsUrl: data.hostedInstructionsUrl,
          }
        : null,
      lastError: p.lastErrorCode || p.lastErrorMessage
        ? { code: p.lastErrorCode, message: p.lastErrorMessage }
        : null,
      ...extra,
    };
  }

  // ───────────────── provider snapshot -> our row (the one place status changes) ─────────────────

  /**
   * Applies the provider's current state to our row. The provider is the
   * source of truth, so webhooks only *trigger* a re-read (retrievePayment)
   * rather than being trusted for ordering. `succeeded` and `canceled` are
   * terminal: once reached, a later (stale) snapshot can't move the payment.
   */
  private async applySnapshot(payment: Payment, snap: ProviderPaymentSnapshot): Promise<Payment> {
    if (payment.status === 'succeeded' || payment.status === 'canceled') {
      return payment;
    }

    payment.providerPaymentId = payment.providerPaymentId ?? snap.providerPaymentId;
    payment.status = snap.status;
    // 'upi_qr' is chosen by us for POD QR payments and must not be overwritten by the charge's 'upi'.
    if (snap.method && payment.method !== 'upi_qr') payment.method = snap.method;

    if (snap.lastError) {
      await this.logAttempt(payment, snap);
      payment.lastErrorCode = snap.lastError.code;
      payment.lastErrorMessage = snap.lastError.message;
    }

    if (snap.qr) {
      payment.providerData = {
        ...(payment.providerData ?? {}),
        qrImageUrl: snap.qr.imageUrlPng,
        qrImageSvg: snap.qr.imageUrlSvg,
        qrExpiresAt: snap.qr.expiresAt.toISOString(),
        hostedInstructionsUrl: snap.qr.hostedInstructionsUrl,
      };
    } else if (snap.status !== 'requires_action' && payment.providerData?.qrImageUrl) {
      // QR no longer applies (expired / paid / canceled) — drop it so it's never shown again.
      const { qrImageUrl, qrImageSvg, qrExpiresAt, hostedInstructionsUrl, ...rest } =
        payment.providerData as Record<string, unknown>;
      payment.providerData = Object.keys(rest).length ? rest : null;
    }

    if (snap.status === 'succeeded') {
      payment.lastErrorCode = null;
      payment.lastErrorMessage = null;
      if (payment.orderSyncStatus === 'none') {
        payment.orderSyncStatus = 'pending';
        payment.nextRetryAt = null;
      }
    }
    return this.payments.save(payment);
  }

  private async logAttempt(payment: Payment, snap: ProviderPaymentSnapshot): Promise<void> {
    const e = snap.lastError;
    if (!e) return;
    if (e.attemptRef) {
      const exists = await this.attempts.exist({
        where: { paymentId: payment.id, providerAttemptRef: e.attemptRef },
      });
      if (exists) return;
    } else if (e.code === payment.lastErrorCode && e.message === payment.lastErrorMessage) {
      return; // same error with no attempt id: already logged
    }
    try {
      await this.attempts.save(
        this.attempts.create({
          paymentId: payment.id,
          providerAttemptRef: e.attemptRef,
          status: 'failed',
          errorCode: e.code,
          declineCode: e.declineCode,
          message: e.message,
        }),
      );
      payment.attemptCount += 1;
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
    }
  }

  /** Re-reads the provider's current state for a non-terminal payment and applies it. */
  private async refreshFromProvider(payment: Payment): Promise<Payment> {
    if (payment.provider === 'manual' || !payment.providerPaymentId) return payment;
    if (payment.status === 'succeeded' || payment.status === 'canceled') return payment;
    const snap = await this.registry.get(payment.provider).retrievePayment(payment.providerPaymentId);
    const updated = await this.applySnapshot(payment, snap);
    if (updated.status === 'succeeded') await this.syncOrder(updated);
    return updated;
  }

  // ───────────────────────── ONLINE CHECKOUT ─────────────────────────

  /**
   * Starts (or resumes) the online payment for an order. The amount comes
   * from the order's locked total in Order-MSV — never from the caller.
   * Calling it again for the same order returns the same payment, so a
   * double tap or "Pay now" after an abandoned sheet is safe.
   */
  async createCheckout(customerId: string, orderId: string): Promise<PaymentView> {
    const order = await this.orderSend<Payable>('get_payable', { orderId });
    if (order.customerId !== customerId) {
      throw new ForbiddenException('This order does not belong to you.');
    }
    if (order.paymentMethod !== 'online') {
      throw new BadRequestException('This order is not an online-payment order.');
    }
    if (order.status === 'cancelled') {
      throw new ConflictException('This order was cancelled.');
    }
    if (order.status !== 'awaiting_payment') {
      throw new ConflictException('This order has already been paid.');
    }
    if (!(order.totalMinor > 0)) {
      throw new BadRequestException('This order has nothing to pay.');
    }

    let payment = await this.findLive(orderId, 'order_online');
    if (payment?.status === 'succeeded') {
      throw new ConflictException('This order has already been paid.');
    }
    if (!payment) {
      try {
        payment = await this.payments.save(
          this.payments.create({
            orderId,
            customerId,
            purpose: 'order_online',
            provider: this.registry.active.name,
            amountMinor: order.totalMinor,
            currency: 'INR',
            status: 'created',
          }),
        );
      } catch (err) {
        if (!this.isUniqueViolation(err)) throw err;
        payment = await this.findLive(orderId, 'order_online'); // concurrent double tap
        if (!payment) throw err;
      }
    }

    const provider = this.registry.get(payment.provider);
    let snap: ProviderPaymentSnapshot;
    if (!payment.providerPaymentId) {
      // First time, or an earlier attempt crashed before saving the provider id:
      // the provider-side idempotency key (per payment row) makes this safe to repeat.
      snap = await provider.createPayment({
        paymentId: payment.id,
        orderId,
        customerId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        kind: 'online',
      });
    } else {
      snap = await provider.retrievePayment(payment.providerPaymentId);
    }
    payment = await this.applySnapshot(payment, snap);

    if (payment.status === 'succeeded') {
      await this.syncOrder(payment);
      throw new ConflictException('This order has already been paid.');
    }
    if (payment.status === 'canceled') {
      // Provider-side cancel (e.g. a cancelled order's intent): nothing resumable.
      throw new ConflictException('This payment was cancelled. Please start a new one.');
    }
    return this.toView(payment, { clientSecret: snap.clientSecret });
  }

  // ───────────────────────── POD: UPI QR ─────────────────────────

  private async requireOwnedPodOrder(staffId: string, orderId: string): Promise<Payable> {
    const order = await this.orderSend<Payable>('get_payable', { orderId });
    if (order.paymentMethod !== 'pod') {
      throw new BadRequestException('This order is not pay-on-delivery.');
    }
    if (order.assignedStaffId !== staffId) {
      throw new ForbiddenException('This order is not assigned to you.');
    }
    return order;
  }

  /**
   * Creates (or returns, or regenerates) the dynamic UPI QR for a POD order.
   * Exactly one live payment per order is allowed by the database, so a QR and
   * a cash payment can never coexist.
   */
  async createPodQr(staffId: string, orderId: string): Promise<PaymentView> {
    const order = await this.requireOwnedPodOrder(staffId, orderId);
    if (order.status !== 'out_for_delivery') {
      throw new ConflictException('Mark the order out for delivery before collecting payment.');
    }
    if (order.paymentConfirmedAt) {
      throw new ConflictException('Payment for this order was already confirmed.');
    }

    let live = await this.findLive(orderId, 'order_pod');
    if (live) {
      if (live.method === 'cash') {
        throw new ConflictException('Cash was already recorded for this order.');
      }
      live = await this.refreshFromProvider(live);
      if (live.status === 'succeeded') {
        throw new ConflictException('This order has already been paid by UPI.');
      }
      const data = (live.providerData ?? {}) as Record<string, any>;
      const qrStillValid =
        live.status === 'requires_action' &&
        data.qrImageUrl &&
        new Date(data.qrExpiresAt).getTime() > Date.now();
      if (live.status === 'processing' || qrStillValid) {
        return this.toView(live);
      }
      // Expired / failed QR: retire it, then fall through to create a fresh one.
      if (live.status !== 'canceled' && live.providerPaymentId) {
        const result = await this.registry.get(live.provider).cancelPayment(live.providerPaymentId);
        live = await this.applySnapshot(live, result.snapshot);
        if (result.outcome === 'succeeded') {
          await this.syncOrder(live);
          throw new ConflictException('This order has already been paid by UPI.');
        }
        if (result.outcome === 'processing') return this.toView(live);
      } else if (live.status !== 'canceled') {
        live.status = 'canceled';
        live = await this.payments.save(live);
      }
    }

    let payment: Payment | null;
    try {
      payment = await this.payments.save(
        this.payments.create({
          orderId,
          customerId: order.customerId,
          purpose: 'order_pod',
          method: 'upi_qr',
          provider: this.registry.active.name,
          amountMinor: order.totalMinor,
          currency: 'INR',
          status: 'created',
        }),
      );
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
      payment = await this.findLive(orderId, 'order_pod'); // concurrent tap
      if (!payment) throw err;
      return this.toView(payment);
    }

    const snap = await this.registry.get(payment.provider).createPayment({
      paymentId: payment.id,
      orderId,
      customerId: order.customerId,
      customerName: order.customerName,
      customerAddress: order.customerAddress,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      kind: 'upi_qr',
    });
    payment = await this.applySnapshot(payment, snap);
    return this.toView(payment);
  }

  /** Staff left the UPI page: retire the QR unless the money is already moving. */
  async cancelPodQr(staffId: string, orderId: string): Promise<{ result: 'canceled' | 'none' | 'succeeded' | 'processing' }> {
    await this.requireOwnedPodOrder(staffId, orderId);
    let live = await this.findLive(orderId, 'order_pod');
    if (!live || live.method === 'cash') return { result: 'none' };
    if (live.status === 'succeeded') return { result: 'succeeded' };
    if (!live.providerPaymentId) {
      live.status = 'canceled';
      await this.payments.save(live);
      return { result: 'canceled' };
    }
    const outcome = await this.registry.get(live.provider).cancelPayment(live.providerPaymentId);
    live = await this.applySnapshot(live, outcome.snapshot);
    if (outcome.outcome === 'succeeded') await this.syncOrder(live);
    return { result: outcome.outcome };
  }

  /** Cash collected at the door: a manual ledger row. The unique index refuses it while a QR payment is live. */
  async recordCash(input: {
    orderId: string;
    customerId: string;
    staffId: string;
    amountMinor: number;
  }): Promise<PaymentView> {
    const existing = await this.findLive(input.orderId, 'order_pod');
    if (existing) return this.existingCashOrConflict(existing);
    try {
      const row = await this.payments.save(
        this.payments.create({
          orderId: input.orderId,
          customerId: input.customerId,
          purpose: 'order_pod',
          method: 'cash',
          provider: 'manual',
          amountMinor: input.amountMinor,
          currency: 'INR',
          status: 'succeeded',
          collectedByStaffId: input.staffId,
        }),
      );
      return this.toView(row);
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
      const live = await this.findLive(input.orderId, 'order_pod');
      if (!live) throw err;
      return this.existingCashOrConflict(live);
    }
  }

  private existingCashOrConflict(live: Payment): PaymentView {
    if (live.method === 'cash') return this.toView(live); // idempotent repeat
    throw new ConflictException(
      'A UPI QR payment is open for this order. Finish or cancel it before taking cash.',
    );
  }

  // ───────────────────────── ORDER CANCELLATION (provider decides) ─────────────────────────

  /**
   * Asked by Order-MSV before it cancels an unpaid online order. The
   * provider's answer is final: if it says the money arrived (or is arriving)
   * the order must not be cancelled.
   */
  async cancelOpenPayments(orderId: string): Promise<{
    result: 'canceled' | 'none' | 'succeeded' | 'processing';
    paymentId?: string;
    provider?: string;
    reference?: string;
  }> {
    let live = await this.findLive(orderId, 'order_online');
    if (!live) return { result: 'none' };

    const succeeded = (p: Payment) => ({
      result: 'succeeded' as const,
      paymentId: p.id,
      provider: p.provider,
      reference: p.providerPaymentId ?? undefined,
    });

    if (live.status === 'succeeded') return succeeded(live);
    if (!live.providerPaymentId) {
      live.status = 'canceled';
      await this.payments.save(live);
      return { result: 'canceled', paymentId: live.id };
    }
    const outcome = await this.registry.get(live.provider).cancelPayment(live.providerPaymentId);
    live = await this.applySnapshot(live, outcome.snapshot);
    if (outcome.outcome === 'succeeded') return succeeded(live);
    if (outcome.outcome === 'processing') return { result: 'processing', paymentId: live.id };
    return { result: 'canceled', paymentId: live.id };
  }

  // ───────────────────────── READ ─────────────────────────

  async getPayment(paymentId: string): Promise<PaymentView> {
    const payment = await this.payments.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found.');
    return this.toView(await this.refreshFromProvider(payment));
  }

  /** Latest live (or most recent) payment of a purpose for an order — used by polling endpoints. */
  async getByOrder(orderId: string, purpose?: PaymentPurpose): Promise<PaymentView[]> {
    const rows = await this.payments.find({
      where: { orderId, ...(purpose ? { purpose } : {}) },
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => this.toView(r));
  }

  // ───────────────────────── TELL ORDER-MSV ─────────────────────────

  /**
   * Reports a succeeded payment to Order-MSV. Safe to repeat (both Order
   * commands are idempotent); failures are recorded for the reconciler to retry.
   */
  async syncOrder(payment: Payment): Promise<void> {
    if (payment.orderSyncStatus !== 'pending') return;
    try {
      if (payment.purpose === 'order_online') {
        const res = await this.orderSend<{ outcome: 'paid' | 'already_paid' | 'order_cancelled' }>(
          'mark_paid',
          { orderId: payment.orderId, provider: payment.provider, paymentId: payment.id },
        );
        if (res?.outcome === 'order_cancelled') {
          // Paid after the order was cancelled (race): hand the money back.
          await this.requestRefund(payment.id, 'order_cancelled');
        }
      } else if (payment.purpose === 'order_pod' && payment.method === 'upi_qr') {
        try {
          await this.orderSend('mark_cod_paid', {
            orderId: payment.orderId,
            provider: payment.provider,
            paymentId: payment.id,
          });
        } catch (err) {
          if (!this.isConflict(err)) throw err;
          // Order already confirmed another way (cash): don't keep double money.
          await this.requestRefund(payment.id, 'duplicate_collection');
        }
      }
      await this.payments.update(payment.id, {
        orderSyncStatus: 'synced',
        nextRetryAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    } catch (err: any) {
      const attempts = payment.orderSyncAttempts + 1;
      const backoffMs = Math.min(2 ** attempts * 10_000, 15 * 60_000);
      this.logger.warn(
        `Order sync failed for payment ${payment.id} (attempt ${attempts}): ${err?.message ?? JSON.stringify(err)}`,
      );
      await this.payments.update(payment.id, {
        orderSyncAttempts: attempts,
        nextRetryAt: new Date(Date.now() + backoffMs),
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    }
  }

  // ───────────────────────── REFUNDS ─────────────────────────

  /**
   * Asks the provider to refund (we request, the provider executes and
   * reports back; refund.* webhooks keep our row in step). Repeating the same
   * reason for a payment returns the existing refund instead of creating another.
   */
  async requestRefund(
    paymentId: string,
    reason: RefundReason,
    amountMinor?: number,
  ): Promise<Refund> {
    const payment = await this.payments.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found.');
    if (payment.status !== 'succeeded' || payment.provider === 'manual' || !payment.providerPaymentId) {
      throw new BadRequestException('Only a succeeded provider payment can be refunded.');
    }

    const open = await this.refunds.findOne({
      where: { paymentId, reason, status: In(['pending', 'requires_action', 'succeeded']) },
    });
    if (open) return open;

    const amount = amountMinor ?? payment.amountMinor - payment.amountRefundedMinor;
    if (!(amount > 0) || amount > payment.amountMinor - payment.amountRefundedMinor) {
      throw new BadRequestException('Nothing left to refund for this payment.');
    }

    let refund = await this.refunds.save(
      this.refunds.create({ paymentId, amountMinor: amount, reason, status: 'pending' }),
    );
    try {
      const snap = await this.registry.get(payment.provider).refundPayment({
        providerPaymentId: payment.providerPaymentId,
        amountMinor: amount,
        reason,
        refundId: refund.id,
      });
      refund = (await this.applyRefundSnapshot(snap, refund)) ?? refund;
    } catch (err: any) {
      refund.status = 'failed';
      refund.failureReason = err?.message ?? 'refund request failed';
      await this.refunds.save(refund);
      throw err;
    }
    return refund;
  }

  private async applyRefundSnapshot(snap: ProviderRefundSnapshot, known?: Refund): Promise<Refund | null> {
    let refund =
      known ??
      (await this.refunds.findOne({ where: { providerRefundId: snap.providerRefundId } }));
    if (!refund) {
      // A refund made outside this service (e.g. from the provider's dashboard): record it.
      const payment = await this.payments.findOne({
        where: { provider: 'stripe', providerPaymentId: snap.providerPaymentId },
      });
      if (!payment) {
        this.logger.warn(`Refund ${snap.providerRefundId} for unknown payment ${snap.providerPaymentId}`);
        return null;
      }
      refund = this.refunds.create({ paymentId: payment.id, amountMinor: snap.amountMinor, reason: 'other' });
    }
    refund.providerRefundId = snap.providerRefundId;
    refund.status = snap.status;
    refund.failureReason = snap.failureReason;
    refund = await this.refunds.save(refund);

    // Keep payments.amount_refunded_minor = SUM of succeeded refunds.
    const { sum } = (await this.refunds
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.amount_minor), 0)', 'sum')
      .where('r.payment_id = :id AND r.status = :s', { id: refund.paymentId, s: 'succeeded' })
      .getRawOne()) as { sum: string };
    await this.payments.update(refund.paymentId, { amountRefundedMinor: Number(sum) });
    return refund;
  }

  // ───────────────────────── WEBHOOK ─────────────────────────

  /**
   * Entry point for provider webhooks (Gateway forwards the raw body + signature).
   * Bad signature -> 400. Duplicates are acknowledged without reprocessing; a
   * failure while processing is recorded and rethrown so the provider retries.
   */
  async handleWebhook(providerName: string, rawBody: string, signature: string) {
    const provider = this.registry.get(providerName);
    let event: NormalizedWebhookEvent;
    try {
      event = provider.parseWebhook(rawBody, signature);
    } catch (err: any) {
      if (err?.getStatus) throw err; // e.g. "not configured"
      throw new BadRequestException('Invalid webhook signature.');
    }

    let row = await this.events.findOne({
      where: { provider: providerName, providerEventId: event.providerEventId },
    });
    if (row?.processedAt) return { received: true, duplicate: true };
    if (!row) {
      try {
        row = await this.events.save(
          this.events.create({
            provider: providerName,
            providerEventId: event.providerEventId,
            type: event.type,
            payload: event.raw,
          }),
        );
      } catch (err) {
        if (!this.isUniqueViolation(err)) throw err;
        row = await this.events.findOne({
          where: { provider: providerName, providerEventId: event.providerEventId },
        });
        if (row?.processedAt) return { received: true, duplicate: true };
      }
    }

    try {
      await this.dispatch(providerName, event);
      if (row) {
        row.processedAt = new Date();
        row.error = null;
        await this.events.save(row);
      }
    } catch (err: any) {
      if (row) {
        row.error = String(err?.message ?? err).slice(0, 500);
        await this.events.save(row);
      }
      throw err;
    }
    return { received: true };
  }

  private async dispatch(providerName: string, event: NormalizedWebhookEvent): Promise<void> {
    if (event.kind === 'payment') {
      const snap = await this.registry.get(providerName).retrievePayment(event.providerPaymentId);
      let payment = await this.payments.findOne({
        where: { provider: providerName, providerPaymentId: event.providerPaymentId },
      });
      if (!payment && snap.ourPaymentId) {
        // Webhook raced our own save of the provider id.
        payment = await this.payments.findOne({ where: { id: snap.ourPaymentId } });
      }
      if (!payment) {
        this.logger.warn(`Webhook ${event.type} for unknown payment ${event.providerPaymentId}`);
        return;
      }
      payment = await this.applySnapshot(payment, snap);
      if (payment.status === 'succeeded') await this.syncOrder(payment);
      return;
    }
    if (event.kind === 'refund') {
      await this.applyRefundSnapshot(event.refund);
      return;
    }
    if (event.kind === 'dispute') {
      // No automated handling yet: make sure it is loud in the logs and kept in payment_events.
      this.logger.error(
        `DISPUTE opened for provider payment ${event.providerPaymentId} — needs manual review (event ${event.providerEventId})`,
      );
    }
  }

  // ───────────────────────── RECONCILER ENTRY POINTS ─────────────────────────

  /** Atomically claims payments whose "tell Order-MSV" step is due, so only one instance works on each. */
  async claimPendingOrderSyncs(limit = 20): Promise<Payment[]> {
    const rows = await this.payments.query(
      `UPDATE payments SET lease_owner = $1, lease_expires_at = now() + ($2 || ' milliseconds')::interval
       WHERE id IN (
         SELECT id FROM payments
         WHERE order_sync_status = 'pending'
           AND (next_retry_at IS NULL OR next_retry_at <= now())
           AND (lease_expires_at IS NULL OR lease_expires_at < now())
         ORDER BY created_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [this.instanceId, String(SYNC_LEASE_MS), limit],
    );
    const ids = (rows?.[0] ?? rows ?? []).map((r: { id: string }) => r.id);
    return ids.length ? this.payments.find({ where: { id: In(ids) } }) : [];
  }

  /** Provider payments still in flight for a while: re-read them in case a webhook was missed. */
  async findStaleInFlight(limit = 20): Promise<Payment[]> {
    return this.payments
      .createQueryBuilder('p')
      .where(`p.provider <> 'manual'`)
      .andWhere(`p.provider_payment_id IS NOT NULL`)
      .andWhere(`p.status IN ('requires_action','processing')`)
      .andWhere(`p.updated_at < now() - interval '60 seconds'`)
      .andWhere(`p.created_at > now() - interval '2 days'`)
      .orderBy('p.updated_at', 'ASC')
      .limit(limit)
      .getMany();
  }

  async reconcileOne(payment: Payment): Promise<void> {
    await this.refreshFromProvider(payment);
  }
}
