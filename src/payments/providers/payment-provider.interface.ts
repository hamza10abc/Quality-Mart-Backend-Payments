import type { PaymentMethodType, PaymentStatus } from '../entities/payment.entity';
import type { RefundReason, RefundStatus } from '../entities/refund.entity';

/** 'online' = customer pays in the app's payment sheet; 'upi_qr' = dynamic UPI QR shown by delivery staff. */
export type ProviderPaymentKind = 'online' | 'upi_qr';

export interface CreateProviderPaymentInput {
  /** Our payments.id — also the provider-side idempotency key base, so retries never create a second payment. */
  paymentId: string;
  orderId: string;
  customerId: string;
  /** Billing name some methods (UPI) require. */
  customerName?: string;
  /** Billing address some methods (UPI) require; only the line is mandatory. */
  customerAddress?: { line1: string; city?: string; state?: string; country?: string };
  amountMinor: number;
  currency: string;
  kind: ProviderPaymentKind;
}

export interface ProviderPaymentSnapshot {
  providerPaymentId: string;
  /** Our payments.id as stored in the provider's metadata — lets a webhook that races our own DB save still find its row. */
  ourPaymentId: string | null;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  /** Known only once the customer chose / the provider recorded a method. */
  method: PaymentMethodType | null;
  /** Needed by the mobile payment sheet; present on create and on retrieve while payable. */
  clientSecret: string | null;
  /** Latest failed attempt info, if any. */
  lastError: ProviderAttemptError | null;
  /** UPI QR details while a QR payment awaits the customer. */
  qr: { imageUrlPng: string; imageUrlSvg: string; expiresAt: Date; hostedInstructionsUrl: string } | null;
}

export interface ProviderAttemptError {
  /** Provider's id for the failed attempt (Stripe: charge id), when it has one. */
  attemptRef: string | null;
  code: string | null;
  declineCode: string | null;
  message: string | null;
}

export interface ProviderCancelResult {
  outcome: 'canceled' | 'succeeded' | 'processing';
  snapshot: ProviderPaymentSnapshot;
}

export interface ProviderRefundSnapshot {
  providerRefundId: string;
  providerPaymentId: string;
  status: RefundStatus;
  amountMinor: number;
  failureReason: string | null;
}

export type NormalizedWebhookEvent =
  | { kind: 'payment'; providerEventId: string; type: string; providerPaymentId: string; raw: Record<string, unknown> }
  | { kind: 'refund'; providerEventId: string; type: string; refund: ProviderRefundSnapshot; raw: Record<string, unknown> }
  | { kind: 'dispute'; providerEventId: string; type: string; providerPaymentId: string | null; raw: Record<string, unknown> }
  | { kind: 'ignored'; providerEventId: string; type: string; raw: Record<string, unknown> };

/**
 * Everything the rest of the service knows about a payment provider. Stripe
 * is the only implementation today; Razorpay etc. add a class implementing
 * this and register it in ProviderRegistry — payment, refund and webhook
 * logic elsewhere never imports a provider SDK.
 */
export interface PaymentProvider {
  readonly name: string;

  createPayment(input: CreateProviderPaymentInput): Promise<ProviderPaymentSnapshot>;
  retrievePayment(providerPaymentId: string): Promise<ProviderPaymentSnapshot>;
  /** Cancels if possible; if the provider says it already succeeded / is processing, reports that instead of throwing. */
  cancelPayment(providerPaymentId: string): Promise<ProviderCancelResult>;
  refundPayment(input: {
    providerPaymentId: string;
    amountMinor: number;
    reason: RefundReason;
    refundId: string;
  }): Promise<ProviderRefundSnapshot>;
  /** Verifies the signature and normalizes the event. Throws on a bad signature. */
  parseWebhook(rawBody: string, signature: string): NormalizedWebhookEvent;
}
