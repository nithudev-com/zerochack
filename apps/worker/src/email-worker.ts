import { Worker, type Job, type Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { Logger } from 'pino';
import { database } from '@zerochack/database';
import { renderEmailTemplate, monitoringEmailData, type EmailProvider } from '@zerochack/email';

const code=(error:unknown):string=>error instanceof Error&&/^[A-Z][A-Z0-9_:-]{2,119}$/u.test(error.message)?error.message.slice(0,120):'EMAIL_PROVIDER_FAILED';

export async function processEmailDelivery(job:Pick<Job<{deliveryId:string}>,'data'|'attemptsMade'|'opts'>,provider:EmailProvider):Promise<void>{
  const delivery=await database.emailDelivery.findUnique({where:{id:job.data.deliveryId},include:{event:true,templateVersion:true}});if(!delivery||delivery.status==='DELIVERED'||delivery.status==='SUPPRESSED')return;const staleBefore=new Date(Date.now()-120_000);if(delivery.status==='SENDING'&&delivery.attemptStartedAt&&delivery.attemptStartedAt>staleBefore)throw new Error('EMAIL_DELIVERY_BUSY');
  if (delivery.event.eventType === 'MONITORING_ALERT') {
    const [recipient, membership, preference, permissions] = await Promise.all([
      database.user.findUnique({ where: { id: delivery.recipientUserId }, select: { email: true, status: true, emailVerifiedAt: true } }),
      database.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId: delivery.tenantId, userId: delivery.recipientUserId } }, select: { status: true } }),
      database.notificationPreference.findUnique({ where: { tenantId_userId_eventType: { tenantId: delivery.tenantId, userId: delivery.recipientUserId, eventType: 'MONITORING_ALERT' } }, select: { emailEnabled: true } }),
      database.userRole.count({ where: { tenantId: delivery.tenantId, userId: delivery.recipientUserId, role: { permissions: { some: { permission: { key: 'websites.read' } } } } } })
    ]);
    if (!recipient?.emailVerifiedAt || recipient.status !== 'APPROVED' || recipient.email !== delivery.recipientEmail || membership?.status !== 'ACTIVE' || preference?.emailEnabled === false || permissions === 0) {
      await database.emailDelivery.update({ where: { id: delivery.id }, data: { status: 'SUPPRESSED', nextAttemptAt: null, attemptStartedAt: null, lastErrorCode: 'RECIPIENT_AUTHORIZATION_CHANGED' } }); return;
    }
  }
  if(delivery.event.eventType==='MONITORING_ALERT'&&delivery.attempts>=5){await database.emailDelivery.update({where:{id:delivery.id},data:{status:'FAILED',lastErrorCode:delivery.status==='SENDING'?'SMTP_OUTCOME_UNKNOWN':'SMTP_RETRY_EXHAUSTED',attemptStartedAt:null}});return;}
  const claimed=await database.emailDelivery.updateMany({where:{id:delivery.id,...(delivery.event.eventType==='MONITORING_ALERT'?{attempts:{lt:5}}:{}),OR:[{status:{in:['QUEUED','RETRYING','FAILED']}},{status:'SENDING',attemptStartedAt:{lte:staleBefore}}]},data:{status:'SENDING',attempts:{increment:1},nextAttemptAt:null,attemptStartedAt:new Date()}});if(!claimed.count)return;
  try{const payload=typeof delivery.event.payload==='object'&&delivery.event.payload!==null&&!Array.isArray(delivery.event.payload)?delivery.event.payload as Record<string,unknown>:{};const monitoring=delivery.event.eventType==='MONITORING_ALERT'?monitoringEmailData(payload.monitoring,process.env.APP_URL??'https://codebandage.com'):undefined;const renderedSubject=renderEmailTemplate(delivery.templateVersion.subjectTemplate,payload,240);const subject=monitoring?`${monitoring.state==='RECOVERED'?'UP':monitoring.state} · ${renderedSubject}`.slice(0,240):renderedSubject;const text=renderEmailTemplate(delivery.templateVersion.bodyTemplate,payload);const result=await provider.send({to:delivery.recipientEmail,subject,text,idempotencyKey:delivery.idempotencyKey,...(monitoring?{monitoring}:{})});await database.$transaction([database.emailDelivery.update({where:{id:delivery.id},data:{status:'DELIVERED',providerMessageId:result.providerMessageId,deliveredAt:new Date(),lastErrorCode:null,attemptStartedAt:null}}),database.auditLog.create({data:{tenantId:delivery.tenantId,requestId:`email:${delivery.id}`.slice(0,100),action:'email.delivered',resourceType:'email_delivery',resourceId:delivery.id,metadata:{eventType:delivery.event.eventType,attempt:job.attemptsMade+1}}})]);}
  catch(error){const attempts=typeof job.opts.attempts==='number'?job.opts.attempts:1;const final=job.attemptsMade+1>=attempts||(delivery.event.eventType==='MONITORING_ALERT'&&delivery.attempts+1>=5);const delay=2_000*(2**job.attemptsMade);await database.$transaction([database.emailDelivery.update({where:{id:delivery.id},data:{status:final?'FAILED':'RETRYING',lastErrorCode:code(error),nextAttemptAt:final?null:new Date(Date.now()+delay),attemptStartedAt:null}}),database.auditLog.create({data:{tenantId:delivery.tenantId,requestId:`email:${delivery.id}:${job.attemptsMade+1}`.slice(0,100),action:final?'email.failed':'email.retry_scheduled',resourceType:'email_delivery',resourceId:delivery.id,metadata:{attempt:job.attemptsMade+1,errorCode:code(error)}}})]);throw error;}
}

export async function reconcileMonitoringEmailJobs(queue: Pick<Queue, 'add' | 'getJob'>): Promise<number> {
  const now = new Date(); const stale = new Date(now.getTime() - 120000);
  await database.emailDelivery.updateMany({ where: { event: { eventType: 'MONITORING_ALERT', deduplicationKey: { startsWith: 'uptime:' } }, status: 'SENDING', attemptStartedAt: { lte: stale }, attempts: { gte: 5 } }, data: { status: 'FAILED', lastErrorCode: 'SMTP_OUTCOME_UNKNOWN', attemptStartedAt: null } });
  const deliveries = await database.emailDelivery.findMany({ where: { event: { eventType: 'MONITORING_ALERT', deduplicationKey: { startsWith: 'uptime:' } }, attempts: { lt: 5 }, OR: [{ status: 'SENDING', attemptStartedAt: { lte: stale } }, { status: 'QUEUED', createdAt: { lte: stale } }, { status: 'RETRYING', nextAttemptAt: { lte: now } }] }, take: 100, orderBy: { createdAt: 'asc' }, select: { id: true } });
  for (const delivery of deliveries) { const job = await queue.getJob(delivery.id); if (job) { const state = await job.getState(); if (state === 'failed' || state === 'completed') await job.retry(state); } else await queue.add('email.deliver', { deliveryId: delivery.id }, { jobId: delivery.id, attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 }); }
  return deliveries.length;
}
export function createEmailWorker(redisUrl:string,logger:Logger,provider:EmailProvider):Worker{const worker=new Worker('email',(job:Job<{deliveryId:string}>)=>processEmailDelivery(job,provider),{connection:new IORedis(redisUrl,{maxRetriesPerRequest:null}),concurrency:5});worker.on('failed',job=>logger.error({jobId:job?.id,errorCode:'EMAIL_JOB_FAILED'},'email.job_failed'));return worker;}
