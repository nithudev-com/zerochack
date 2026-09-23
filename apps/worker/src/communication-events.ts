import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { Prisma } from '@prisma/client';
import { database } from '@zerochack/database';
import type { CommunicationEventType } from '@zerochack/notifications';

export async function emitTenantEvent(input:{tenantId:string;eventType:CommunicationEventType;deduplicationKey:string;title:string;message:string;actionUrl:string;data?:Prisma.InputJsonObject},redisUrl:string):Promise<void>{
  const recipients=await database.tenantMembership.findMany({where:{tenantId:input.tenantId,status:'ACTIVE'},include:{user:{select:{displayName:true}}}});const connection=new IORedis(redisUrl,{maxRetriesPerRequest:null});const queue=new Queue('notifications',{connection});
  try{for(const membership of recipients){const key=`${input.deduplicationKey}:${membership.userId}`;let event=await database.communicationEvent.findUnique({where:{deduplicationKey:key}});if(!event)event=await database.communicationEvent.create({data:{tenantId:input.tenantId,recipientUserId:membership.userId,eventType:input.eventType,deduplicationKey:key,payload:{title:input.title,message:input.message,actionUrl:input.actionUrl,recipientName:membership.user.displayName??'there',...(input.data??{})}}}).catch(async()=>database.communicationEvent.findUniqueOrThrow({where:{deduplicationKey:key}}));if(!event.processedAt)await queue.add('communication.process',{eventId:event.id},{jobId:event.id,attempts:5,backoff:{type:'exponential',delay:2_000},removeOnComplete:1000,removeOnFail:5000});}}
  finally{await queue.close();connection.disconnect();}
}
