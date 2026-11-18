import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Every webhook delivery, deduped per provider event id; also the audit trail. */
@Entity('payment_events')
@Index('UQ_payment_events_provider_event', ['provider', 'providerEventId'], { unique: true })
export class PaymentEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  provider: string;

  @Column({ type: 'text', name: 'provider_event_id' })
  providerEventId: string;

  @Column({ type: 'text' })
  type: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  /** Set once the event has been fully handled; null = received but not (successfully) processed yet. */
  @Column({ type: 'timestamptz', name: 'processed_at', nullable: true })
  processedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;
}
