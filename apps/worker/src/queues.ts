import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

export const queueNames = ['default', 'email', 'notifications', 'scans', 'monitoring', 'backups', 'reports', 'ai'] as const;
export type QueueName = (typeof queueNames)[number];

export function createQueueRegistry(redisUrl: string): { queues: Map<QueueName, Queue>; events: QueueEvents[]; close: () => Promise<void> } {
  const producerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queues = new Map(queueNames.map((name) => [name, new Queue(name, { connection: producerConnection })]));
  const events = queueNames.map((name) => new QueueEvents(name, { connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) }));
  return {
    queues,
    events,
    close: async () => {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
      await Promise.all(events.map((event) => event.close()));
      producerConnection.disconnect();
    }
  };
}
