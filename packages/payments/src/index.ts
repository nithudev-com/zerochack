import { createHmac, timingSafeEqual } from 'node:crypto';

export type Money = Readonly<{ amountMinor: number; currency: string }>;
export type ProviderContext = Readonly<{ credentials: string; requestId: string; idempotencyKey: string }>;
export interface CheckoutRequest extends Money { tenantId: string; productReference: string; packageVersionId?: string; securityFixOrderId?: string; successUrl: string; cancelUrl: string; metadata: Record<string, string>; }
export interface CheckoutResult { checkoutReference: string; checkoutUrl: string; }
export interface PaymentVerification { verified: boolean; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'; paymentReference?: string; subscriptionReference?: string; invoiceReference?: string; currentPeriodEnd?: Date; }
export interface ProviderSubscriptionRequest extends Money { tenantId: string; packageVersionId: string; trialDays: number; metadata: Record<string, string>; }
export interface ProviderSubscriptionResult { subscriptionReference: string; status: 'TRIALING' | 'ACTIVE'; trialEndsAt?: Date; currentPeriodEnd?: Date; }
export interface ProviderInvoiceRequest extends Money { tenantId: string; subscriptionReference?: string; lineItems: ReadonlyArray<{ description: string; quantity: number; unitMinor: number }>; }
export interface ProviderInvoiceResult { invoiceReference: string; status: 'DRAFT' | 'OPEN' | 'PAID'; }
export interface ProviderRefundResult { refundReference: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED'; }
export interface ProviderCancellationResult { cancelled: boolean; effectiveAt: Date; }
export interface VerifiedWebhookEvent { eventId: string; type: string; occurredAt: Date; checkoutReference?: string; paymentReference?: string; subscriptionReference?: string; invoiceReference?: string; status?: string; amountMinor?: number; currency?: string; }

export interface PaymentProvider {
  readonly adapterKey: string;
  createCheckout(request: CheckoutRequest, context: ProviderContext): Promise<CheckoutResult>;
  verifyPayment(reference: string, context: ProviderContext): Promise<PaymentVerification>;
  createSubscription(request: ProviderSubscriptionRequest, context: ProviderContext): Promise<ProviderSubscriptionResult>;
  createInvoice(request: ProviderInvoiceRequest, context: ProviderContext): Promise<ProviderInvoiceResult>;
  refund(paymentReference: string, amount: Money, reason: string | undefined, context: ProviderContext): Promise<ProviderRefundResult>;
  cancelSubscription(subscriptionReference: string, context: ProviderContext): Promise<ProviderCancellationResult>;
  verifyWebhook(rawPayload: string, headers: Readonly<Record<string, string | string[] | undefined>>, credentials: string): Promise<VerifiedWebhookEvent>;
  health(credentials: string): Promise<'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE'>;
}

export class PaymentProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); this.name = 'PaymentProviderError'; }
}

export class PaymentProviderRegistry {
  private readonly adapters = new Map<string, PaymentProvider>();
  constructor(adapters: readonly PaymentProvider[] = []) { for (const adapter of adapters) { if (this.adapters.has(adapter.adapterKey)) throw new Error(`Duplicate payment adapter: ${adapter.adapterKey}`); this.adapters.set(adapter.adapterKey, adapter); } }
  has(adapterKey: string): boolean { return this.adapters.has(adapterKey); }
  get(adapterKey: string): PaymentProvider { const provider = this.adapters.get(adapterKey); if (!provider) throw new PaymentProviderError('PAYMENT_PROVIDER_UNCONFIGURED', `Payment adapter "${adapterKey}" is not installed`); return provider; }
}

/** Constant-time HMAC helper for adapters whose provider signs exact webhook bytes. */
export function verifyHmacSha256(rawPayload: string, suppliedSignature: string, secret: string): boolean {
  const expected = Buffer.from(createHmac('sha256', secret).update(rawPayload).digest('hex'));
  const supplied = Buffer.from(suppliedSignature.replace(/^sha256=/u, '').toLowerCase());
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
export function isWebhookFresh(occurredAt: Date, now = new Date(), toleranceSeconds = 300): boolean { return Number.isFinite(occurredAt.getTime()) && Math.abs(now.getTime() - occurredAt.getTime()) <= toleranceSeconds * 1000; }
