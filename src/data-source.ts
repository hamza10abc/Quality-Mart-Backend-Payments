/**
 * TypeORM CLI DataSource — used ONLY for migration:generate / migration:run / migration:revert.
 * The running Nest app configures its connection via TypeOrmModule.forRoot() in app.module.ts.
 *
 * Usage:
 *   npm run migration:generate -- src/migrations/SomeName
 *   npm run migration:run
 *   npm run migration:revert
 */
import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Payment } from './payments/entities/payment.entity';
import { PaymentAttempt } from './payments/entities/payment-attempt.entity';
import { PaymentEvent } from './payments/entities/payment-event.entity';
import { Refund } from './payments/entities/refund.entity';

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER_NAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'quality_mart_payments_db',

  entities: [Payment, PaymentAttempt, PaymentEvent, Refund],

  migrations: ['src/migrations/*.ts'],

  synchronize: false,
});
