import { RhinoQClient } from '@rhinoq/node';
import { gatewayToken, gatewayURL } from './config';

export const rhinoq = new RhinoQClient({ url: gatewayURL, token: gatewayToken, timeoutMs: 5_000 });
export const findingKey = (orderId: string) => ({
  ruleId: 'completed-refund-has-order-state',
  subjectType: 'order',
  subjectId: orderId,
  invariantVersion: 1,
});
