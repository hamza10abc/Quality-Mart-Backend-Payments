import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from './entities/payment.entity';
import { PaymentAttempt } from './entities/payment-attempt.entity';
import { PaymentEvent } from './entities/payment-event.entity';
import { Refund } from './entities/refund.entity';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsReconciliationService } from './payments-reconciliation.service';
import { ProviderRegistry } from './providers/provider.registry';
import { StripeProvider } from './providers/stripe.provider';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, PaymentAttempt, PaymentEvent, Refund]),
    ClientsModule.register([
      {
        name: 'ORDER_SERVICE',
        transport: Transport.TCP,
        options: {
          host: process.env.ORDER_SERVICE_HOST || 'localhost',
          port: parseInt(process.env.ORDER_SERVICE_PORT ?? '4009', 10),
        },
      },
    ]),
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentsReconciliationService, ProviderRegistry, StripeProvider],
  exports: [PaymentsService],
})
export class PaymentsModule {}
