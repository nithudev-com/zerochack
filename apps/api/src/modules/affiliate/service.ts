import type { Prisma } from '@prisma/client';

export async function createCommissionForPayment(tx: Prisma.TransactionClient, paymentTransactionId: string): Promise<string | null> {
  const existing = await tx.affiliateConversion.findUnique({ where: { paymentTransactionId } }); if (existing) return existing.id;
  const payment = await tx.paymentTransaction.findUnique({ where: { id: paymentTransactionId } }); if (!payment || payment.status !== 'SUCCEEDED') return null;
  const attribution = await tx.referralAttribution.findUnique({ where: { customerTenantId: payment.tenantId }, include: { config: { include: { eligibleProducts: true } }, affiliate: true } });
  if (!attribution || !attribution.affiliate.active || !['ACTIVE', 'CONVERTED'].includes(attribution.status)) return null;
  if (attribution.status === 'ACTIVE' && attribution.expiresAt <= new Date()) { await tx.referralAttribution.update({ where: { id: attribution.id }, data: { status: 'EXPIRED' } }); return null; }
  if (!attribution.config.eligibleProducts.some((item) => item.packageVersionId === payment.packageVersionId)) return null;
  const prior = await tx.affiliateConversion.count({ where: { attributionId: attribution.id } });
  const rules = attribution.config.eligibilityRules as { minimumPaymentMinor?: number; newCustomersOnly?: boolean };
  if ((rules.minimumPaymentMinor ?? 0) > payment.amountMinor || (rules.newCustomersOnly === true && prior > 0)) return null;
  const period = prior + 1;
  if (attribution.config.commissionKind === 'ONE_TIME' && period > 1) return null;
  if (attribution.config.commissionKind === 'RECURRING' && period > attribution.config.recurringDurationMonths) return null;
  const amountMinor = attribution.config.calculation === 'PERCENTAGE' ? Math.floor(payment.amountMinor * (attribution.config.percentageBasisPoints ?? 0) / 10_000) : (attribution.config.fixedAmountMinor ?? 0);
  if (amountMinor <= 0) return null;
  const conversion = await tx.affiliateConversion.create({ data: { attributionId: attribution.id, affiliateId: attribution.affiliateId, configId: attribution.configId, customerTenantId: payment.tenantId, paymentTransactionId: payment.id, packageVersionId: payment.packageVersionId, recurringPeriod: period } });
  await tx.affiliateCommission.create({ data: { conversionId: conversion.id, affiliateId: attribution.affiliateId, amountMinor, currency: payment.currency, status: attribution.config.approvalRequired ? 'PENDING' : 'PAYABLE', ruleSnapshot: { configId: attribution.config.id, version: attribution.config.version, commissionKind: attribution.config.commissionKind, calculation: attribution.config.calculation, percentageBasisPoints: attribution.config.percentageBasisPoints, fixedAmountMinor: attribution.config.fixedAmountMinor, recurringDurationMonths: attribution.config.recurringDurationMonths, paymentAmountMinor: payment.amountMinor } } });
  if (attribution.status === 'ACTIVE') await tx.referralAttribution.update({ where: { id: attribution.id }, data: { status: 'CONVERTED', convertedAt: new Date() } });
  return conversion.id;
}

export async function reverseCommissionForPayment(tx: Prisma.TransactionClient, paymentTransactionId: string, reason: string): Promise<number> {
  const conversion = await tx.affiliateConversion.findUnique({ where: { paymentTransactionId }, include: { commission: true } });
  if (!conversion?.commission || ['REVERSED', 'CANCELLED'].includes(conversion.commission.status)) return 0;
  if (conversion.commission.status === 'PAID') throw new Error('PAID_COMMISSION_REVERSAL_REQUIRES_RECOVERY');
  await tx.affiliateCommission.update({ where: { id: conversion.commission.id }, data: { status: 'REVERSED', reversedAt: new Date(), reversalReason: reason } }); return 1;
}
