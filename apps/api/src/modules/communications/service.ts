import type { Queue } from 'bullmq';
import { database } from '@zerochack/database';
import type { NotificationRequest } from '@zerochack/notifications';

const duplicate = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

export async function publishCommunicationEvent(input: NotificationRequest, queue?: Queue): Promise<{ eventId: string; duplicate: boolean }> {
  const membership = await database.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId: input.tenantId, userId: input.recipientId } }, include: { user: { select: { displayName: true } } } });
  if (!membership) throw new Error('COMMUNICATION_RECIPIENT_INVALID');
  let event; let isDuplicate = false;
  try {
    event = await database.communicationEvent.create({ data: { tenantId: input.tenantId, recipientUserId: input.recipientId, eventType: input.eventType, deduplicationKey: input.deduplicationKey, payload: { title: input.title.slice(0, 240), message: input.message.slice(0, 10_000), actionUrl: input.actionUrl.slice(0, 2048), recipientName: membership.user.displayName ?? 'there', ...(input.data ?? {}) } } });
  } catch (error) {
    if (!duplicate(error)) throw error;
    event = await database.communicationEvent.findUniqueOrThrow({ where: { deduplicationKey: input.deduplicationKey } }); isDuplicate = true;
  }
  if (queue && !event.processedAt) await queue.add('communication.process', { eventId: event.id }, { jobId: event.id, attempts: 5, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: 1000, removeOnFail: 5000 });
  return { eventId: event.id, duplicate: isDuplicate };
}

export async function publishTenantEvent(input: Omit<NotificationRequest,'recipientId'|'deduplicationKey'> & { recipientId?: string; deduplicationKey: string }, queue?: Queue): Promise<Array<{ eventId:string;duplicate:boolean}>> {
  const recipients=input.recipientId?[input.recipientId]:(await database.tenantMembership.findMany({where:{tenantId:input.tenantId,status:'ACTIVE'},select:{userId:true}})).map((item)=>item.userId);
  return Promise.all(recipients.map((recipientId)=>publishCommunicationEvent({...input,recipientId,deduplicationKey:`${input.deduplicationKey}:${recipientId}`},queue)));
}
