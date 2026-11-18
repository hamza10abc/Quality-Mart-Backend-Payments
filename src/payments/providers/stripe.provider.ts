import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import type { PaymentMethodType, PaymentStatus } from '../entities/payment.entity';
import type { RefundReason, RefundStatus } from '../entities/refund.entity';
import type {
  CreateProviderPaymentInput,
  NormalizedWebhookEvent,
  PaymentProvider,
  ProviderAttemptError,
  ProviderCancelResult,
  ProviderPaymentSnapshot,
  ProviderRefundSnapshot,
} from './payment-provider.interface';

const STATUS_MAP: Record<string, PaymentStatus> = {
  requires_payment_method: 'requires_payment_method',
  // We confirm client-side / server-side as soon as we create, so a PI waiting
  // for confirmation is, from our point of view, waiting on the customer.
  requires_confirmation: 'requires_action',
  requires_action: 'requires_action',
  processing: 'processing',
  // Automatic capture is used everywhere; if a capture-pending PI ever shows
  // up, treat it as in-flight rather than paid.
  requires_capture: 'processing',
  succeeded: 'succeeded',
  canceled: 'canceled',
};

const REFUND_STATUS_MAP: Record<string, RefundStatus> = {
  pending: 'pending',
  requires_action: 'requires_action',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
};

@Injectable()
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly logger = new Logger(StripeProvider.name);
  private client: Stripe | null = null;

  /** Methods offered in the in-app payment sheet, e.g. "card,upi,netbanking". */
  private get methodTypes(): string[] {
    return (process.env.PAYMENT_METHODS ?? 'card,upi,netbanking')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  }

  // Lazy so the service can boot (and run migrations / serve cash rows) before
  // Stripe keys are configured; only Stripe calls need the key.
  private get stripe(): Stripe {
    if (!this.client) {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) {
        throw new ServiceUnavailableException('Online payments are not configured yet.');
      }
      this.client = new Stripe(key);
    }
    return this.client;
  }

  async createPayment(input: CreateProviderPaymentInput): Promise<ProviderPaymentSnapshot> {
    const params: Stripe.PaymentIntentCreateParams = {
      amount: input.amountMinor,
      currency: input.currency.toLowerCase(),
      metadata: {
        paymentId: input.paymentId,
        orderId: input.orderId,
        customerId: input.customerId,
        kind: input.kind,
      },
      allowed_payment_method_types: (input.kind === 'upi_qr'
        ? ['upi']
        : this.methodTypes) as Stripe.PaymentIntentCreateParams.AllowedPaymentMethodType[],
    };
    if (input.kind === 'upi_qr') {
      // Server-side confirm: Stripe returns the dynamic QR in next_action.
      // Stripe requires a billing name AND an address (at least the line) on
      // UPI payment methods; postal code is not needed. The shop only
      // delivers within India, so a free-text country that isn't a 2-letter
      // code (e.g. "India") is sent as IN.
      const addr = input.customerAddress;
      const country = addr?.country && /^[A-Za-z]{2}$/.test(addr.country.trim()) ? addr.country.trim().toUpperCase() : 'IN';
      params.payment_method_data = {
        type: 'upi',
        billing_details: {
          name: input.customerName || 'Customer',
          address: {
            line1: addr?.line1 || 'Delivery address',
            ...(addr?.city ? { city: addr.city } : {}),
            ...(addr?.state ? { state: addr.state } : {}),
            country,
          },
        },
      };
      params.confirm = true;
      if (process.env.STRIPE_UPI_RETURN_URL) {
        params.return_url = process.env.STRIPE_UPI_RETURN_URL;
      }
    }
    const pi = await this.call(
      this.stripe.paymentIntents.create(params, {
        // Stable per payment row: a retried create (crash, timeout) returns the
        // same PaymentIntent instead of making a second one.
        idempotencyKey: `pi_create_${input.paymentId}`,
      }),
    );
    return this.toSnapshot(pi, input.kind === 'upi_qr' ? 'upi_qr' : undefined);
  }

  async retrievePayment(providerPaymentId: string): Promise<ProviderPaymentSnapshot> {
    const pi = await this.call(
      this.stripe.paymentIntents.retrieve(providerPaymentId, {
        expand: ['latest_charge'],
      }),
    );
    return this.toSnapshot(pi, pi.metadata?.kind === 'upi_qr' ? 'upi_qr' : undefined);
  }

  async cancelPayment(providerPaymentId: string): Promise<ProviderCancelResult> {
    try {
      const pi = await this.stripe.paymentIntents.cancel(providerPaymentId);
      return { outcome: 'canceled', snapshot: this.toSnapshot(pi) };
    } catch (err) {
      // Stripe refuses to cancel a PI that already succeeded or is processing.
      // That refusal IS the answer we want: re-read it and report the state.
      if (err instanceof Stripe.errors.StripeInvalidRequestError) {
        const snapshot = await this.retrievePayment(providerPaymentId);
        if (snapshot.status === 'succeeded') return { outcome: 'succeeded', snapshot };
        if (snapshot.status === 'processing') return { outcome: 'processing', snapshot };
        if (snapshot.status === 'canceled') return { outcome: 'canceled', snapshot };
      }
      throw err;
    }
  }

  async refundPayment(input: {
    providerPaymentId: string;
    amountMinor: number;
    reason: RefundReason;
    refundId: string;
  }): Promise<ProviderRefundSnapshot> {
    const refund = await this.call(
      this.stripe.refunds.create(
      {
        payment_intent: input.providerPaymentId,
        amount: input.amountMinor,
        ...(input.reason === 'duplicate_collection'
          ? { reason: 'duplicate' as const }
          : input.reason === 'customer_request'
            ? { reason: 'requested_by_customer' as const }
            : {}),
        metadata: { refundId: input.refundId, reason: input.reason },
      },
      { idempotencyKey: `refund_${input.refundId}` },
      ),
    );
    return this.toRefundSnapshot(refund);
  }

  parseWebhook(rawBody: string, signature: string): NormalizedWebhookEvent {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new ServiceUnavailableException('Stripe webhook secret is not configured.');
    }
    // Throws StripeSignatureVerificationError on a bad signature.
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, secret);
    const raw = event as unknown as Record<string, unknown>;
    const type = event.type as string;
    const obj = (event.data as { object: any }).object;

    if (type.startsWith('payment_intent.')) {
      return { kind: 'payment', providerEventId: event.id, type, providerPaymentId: obj.id, raw };
    }
    if (type === 'refund.created' || type === 'refund.updated' || type === 'refund.failed') {
      return {
        kind: 'refund',
        providerEventId: event.id,
        type,
        refund: this.toRefundSnapshot(obj as Stripe.Refund),
        raw,
      };
    }
    if (type === 'charge.dispute.created') {
      const pi = obj?.payment_intent;
      return {
        kind: 'dispute',
        providerEventId: event.id,
        type,
        providerPaymentId: typeof pi === 'string' ? pi : (pi?.id ?? null),
        raw,
      };
    }
    return { kind: 'ignored', providerEventId: event.id, type, raw };
  }

  // ---------------------------------------------------------------------

  /** Turns any Stripe API failure into one clean 502 (details go to the log, not the client). */
  private async call<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        this.logger.error(`Stripe API error (${err.type}/${err.code ?? '-'}): ${err.message}`);
        throw new BadGatewayException(
          'The payment provider could not process this request. Please try again.',
        );
      }
      throw err;
    }
  }

  private toSnapshot(pi: Stripe.PaymentIntent, forcedMethod?: PaymentMethodType): ProviderPaymentSnapshot {
    const status = STATUS_MAP[pi.status] ?? 'requires_action';
    const qrAction = pi.next_action?.upi_handle_redirect_or_display_qr_code;
    const charge =
      pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;

    return {
      providerPaymentId: pi.id,
      ourPaymentId: pi.metadata?.paymentId ?? null,
      status,
      amountMinor: pi.amount,
      currency: pi.currency.toUpperCase(),
      method: forcedMethod ?? this.methodFromCharge(charge),
      // client_secret is only meaningful while the customer can still pay.
      clientSecret: status === 'succeeded' || status === 'canceled' ? null : (pi.client_secret ?? null),
      lastError: this.toAttemptError(pi),
      qr: qrAction
        ? {
            imageUrlPng: qrAction.qr_code.image_url_png,
            imageUrlSvg: qrAction.qr_code.image_url_svg,
            expiresAt: new Date(qrAction.qr_code.expires_at * 1000),
            hostedInstructionsUrl: qrAction.hosted_instructions_url,
          }
        : null,
    };
  }

  private methodFromCharge(charge: Stripe.Charge | null): PaymentMethodType | null {
    const type = charge?.payment_method_details?.type as string | undefined;
    if (type === 'card' || type === 'upi' || type === 'netbanking') return type;
    return null;
  }

  private toAttemptError(pi: Stripe.PaymentIntent): ProviderAttemptError | null {
    const e = pi.last_payment_error;
    if (!e) return null;
    const charge = typeof e.charge === 'string' ? e.charge : null;
    return {
      attemptRef: charge,
      code: e.code ?? null,
      declineCode: e.decline_code ?? null,
      message: e.message ?? null,
    };
  }

  private toRefundSnapshot(refund: Stripe.Refund): ProviderRefundSnapshot {
    const pi = refund.payment_intent;
    return {
      providerRefundId: refund.id,
      providerPaymentId: typeof pi === 'string' ? pi : (pi?.id ?? ''),
      status: REFUND_STATUS_MAP[refund.status ?? 'pending'] ?? 'pending',
      amountMinor: refund.amount,
      failureReason: refund.failure_reason ?? null,
    };
  }
}
