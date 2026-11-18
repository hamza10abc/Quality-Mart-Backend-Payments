import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** The provider's refund status, mirrored (Stripe: pending, requires_action, succeeded, failed, canceled). */
export type RefundStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';

export type RefundReason =
  | 'order_cancelled'
  | 'duplicate_collection'
  | 'customer_request'
  | 'other';

const bigintToNumber = {
  to: (v?: number | null) => v,
  from: (v?: string | null) => (v == null ? v : Number(v)),
};

/**
 * Refunds are requested by us through the provider's API; the provider
 * executes them and reports the result, which we mirror here. e.g. all
 * processed refunds:  SELECT * FROM refunds WHERE status = 'succeeded'.
 */
@Entity('refunds')
@Index('UQ_refunds_provider_ref', ['providerRefundId'], {
  unique: true,
  where: `"provider_refund_id" IS NOT NULL`,
})
export class Refund {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'payment_id' })
  paymentId: string;

  @Column({ type: 'text', name: 'provider_refund_id', nullable: true })
  providerRefundId: string | null;

  @Column({ type: 'bigint', name: 'amount_minor', transformer: bigintToNumber })
  amountMinor: number;

  @Column({ type: 'text' })
  reason: RefundReason;

  @Column({ type: 'text', default: 'pending' })
  status: RefundStatus;

  @Column({ type: 'text', name: 'failure_reason', nullable: true })
  failureReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
