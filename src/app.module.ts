import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),

    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USER_NAME || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'quality_mart_payments_db',
      autoLoadEntities: true,
      synchronize: false,
      migrations: ['dist/migrations/*.js'],
      // Safe for today's single-instance deployment (idempotent, transactional).
      // Move to an explicit pre-boot step once this runs more than one instance.
      migrationsRun: true,
    }),

    PaymentsModule,
  ],
})
export class AppModule {}
