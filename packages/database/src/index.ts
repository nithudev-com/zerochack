import { PrismaClient } from '@prisma/client';

const globalDatabase = globalThis as unknown as { prisma?: PrismaClient };
export const database = globalDatabase.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalDatabase.prisma = database;

export async function databaseHealthcheck(): Promise<boolean> {
  await database.$queryRaw`SELECT 1`;
  return true;
}

export async function withTenant<T>(tenantId: string, operation: (tx: PrismaClient, tenantId: string) => Promise<T>): Promise<T> {
  if (!tenantId) throw new Error('Tenant context is required');
  return database.$transaction((tx) => operation(tx as PrismaClient, tenantId));
}
