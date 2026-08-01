export const databaseURL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55432/rhinoq';
export const redisURL = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';
export const gatewayURL = process.env.RHINOQ_URL ?? 'http://127.0.0.1:58080';
export const gatewayToken = process.env.RHINOQ_TOKEN ?? 'demo-token-change-me-32-bytes-minimum';
export const appURL = process.env.APP_URL ?? 'http://127.0.0.1:53000';
export const repairSecret = process.env.REPAIR_CALLBACK_SECRET ?? 'demo-repair-secret-change-me-32-bytes';
