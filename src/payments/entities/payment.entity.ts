import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

/**
 * Mirrors the payment provider's PaymentIntent status (Stripe's names), with
 * one local addition: 'created' = our row exists but the provider call hasn't
 * happened (or hasn't completed) yet. Cash ('manual' provider) is inserted as
 * 'succeeded'. No refund / retry / review states live here — refunds are
 * their own table, and our own bookkeeping has its own columns.
 */
export type PaymentStatus =
  | 'created'
  | 'requires_payment_method'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'canceled';

/** order_online = paid at checkout; order_pod = collected at the door. */
export type PaymentPurpose = 'order_online' | 'order_pod';

export type PaymentMethodType = 'card' | 'upi' | 'netbanking' | 'upi_qr' | 'cash';

/** Our own "has Order-MSV been told this was paid" bookkeeping — separate from `status`. */
export type OrderSyncStatus = 'none' | 'pending' | 'synced';

/** bigint comes back from pg as a string; amounts here are small enough for a JS number. */
const bigintToNumber = {
  to: (v?: number | null) => v,
  from: (v?: string | null) => (v == null ? v : Number(v)),
};

@Entity('payments')
// DB-enforced exclusivity: at most ONE live (non-canceled) payment per order
// and purpose. For POD this means a QR payment and a cash payment can never
// both exist for the same order; for online it means one payment attempt
// chain (one PaymentIntent) per order, and none after it has succeeded.
@Index('UQ_payments_live_per_order_purpose', ['orderId', 'purpose'], {
  unique: true,
  where: `"status" <> 'canceled'`,
})
@Index('UQ_payments_provider_ref', ['provider', 'providerPaymentId'], {
  unique: true,
  where: `"provider_payment_id" IS NOT NULL`,
})
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Always set: the order exists before any payment (order-first). Owned by Order-MSV, ID only. */
  @Index()
  @Column({ type: 'text', name: 'order_id' })
  orderId: string;

  @Column({ type: 'text', name: 'customer_id' })
  customerId: string;

  @Column({ type: 'text' })
  purpose: PaymentPurpose;

  /** Unknown for online payments until the customer picks a method in the provider's sheet. */
  @Column({ type: 'text', nullable: true })
  method: PaymentMethodType | null;

  /** 'stripe', later 'razorpay', or 'manual' (cash). */
  @Column({ type: 'text' })
  provider: string;

  @Column({ type: 'text', name: 'provider_payment_id', nullable: true })
  providerPaymentId: string | null;

  /** Smallest currency unit (paise for INR): ₹499.50 is stored as 49950. */
  @Column({ type: 'bigint', name: 'amount_minor', transformer: bigintToNumber })
  amountMinor: number;

  @Column({ type: 'text', default: 'INR' })
  currency: string;

  /** Sum of this payment's successful refunds, same unit as amountMinor. */
  @Column({
    type: 'bigint',
    name: 'amount_refunded_minor',
    default: 0,
    transformer: bigintToNumber,
  })
  amountRefundedMinor: number;

  @Column({ type: 'text', default: 'created' })
  status: PaymentStatus;

  @Column({ type: 'text', name: 'last_error_code', nullable: true })
  lastErrorCode: string | null;

  @Column({ type: 'text', name: 'last_error_message', nullable: true })
  lastErrorMessage: string | null;

  @Column({ type: 'int', name: 'attempt_count', default: 0 })
  attemptCount: number;

  /** Set for cash rows: the staff member who collected it. */
  @Column({ type: 'text', name: 'collected_by_staff_id', nullable: true })
  collectedByStaffId: string | null;

  /** Provider extras worth keeping, e.g. the UPI QR image URL + expiry. Never secrets. */
  @Column({ type: 'jsonb', name: 'provider_data', nullable: true })
  providerData: Record<string, unknown> | null;

  // ── "tell Order-MSV" bookkeeping (retry with lease, same idiom as saga_logs) ──
  @Column({ type: 'text', name: 'order_sync_status', default: 'none' })
  orderSyncStatus: OrderSyncStatus;

  @Column({ type: 'int', name: 'order_sync_attempts', default: 0 })
  orderSyncAttempts: number;

  @Column({ type: 'timestamptz', name: 'next_retry_at', nullable: true })
  nextRetryAt: Date | null;

  @Column({ type: 'text', name: 'lease_owner', nullable: true })
  leaseOwner: string | null;

  @Column({ type: 'timestamptz', name: 'lease_expires_at', nullable: true })
  leaseExpiresAt: Date | null;

  @VersionColumn()
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
