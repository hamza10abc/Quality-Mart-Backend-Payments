import { Injectable, NotFoundException } from '@nestjs/common';
import { StripeProvider } from './stripe.provider';
import type { PaymentProvider } from './payment-provider.interface';

/**
 * Looks providers up by name. To add Razorpay: write a class implementing
 * PaymentProvider, inject it here, and add it to `byName`. Nothing else in
 * the service changes. 'manual' (cash) never goes through a provider.
 */
@Injectable()
export class ProviderRegistry {
  private readonly byName: Record<string, PaymentProvider>;

  constructor(stripe: StripeProvider) {
    this.byName = { [stripe.name]: stripe };
  }

  /** Provider used for NEW online payments (config), e.g. PAYMENT_PROVIDER=stripe. */
  get active(): PaymentProvider {
    return this.get(process.env.PAYMENT_PROVIDER ?? 'stripe');
  }

  get(name: string): PaymentProvider {
    const provider = this.byName[name];
    if (!provider) throw new NotFoundException(`Unknown payment provider "${name}"`);
    return provider;
  }
}
