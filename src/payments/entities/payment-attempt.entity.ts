import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** One row per failed (or succeeded) try on a payment — why a card/UPI/netbanking attempt failed. */
@Entity('payment_attempts')
@Index('UQ_payment_attempts_ref', ['paymentId', 'providerAttemptRef'], {
  unique: true,
  where: `"provider_attempt_ref" IS NOT NULL`,
})
export class PaymentAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'payment_id' })
  paymentId: string;

  /** Provider's id for this attempt (Stripe: the charge id), used to avoid double-logging. */
  @Column({ type: 'text', name: 'provider_attempt_ref', nullable: true })
  providerAttemptRef: string | null;

  @Column({ type: 'text' })
  status: 'failed' | 'succeeded';

  @Column({ type: 'text', name: 'error_code', nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', name: 'decline_code', nullable: true })
  declineCode: string | null;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
