import { Queue } from 'bullmq';
import { redisURL } from './config';

const connection = { url: redisURL, maxRetriesPerRequest: null } as const;
let refundQueue: Queue<{ orderId: string }> | undefined;
export function getRefundQueue(): Queue<{ orderId: string }> {
  refundQueue ??= new Queue<{ orderId: string }>('refunds', { connection });
  return refundQueue;
}
export { connection };
