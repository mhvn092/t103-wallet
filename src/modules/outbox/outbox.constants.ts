export const OUTBOX_EXCHANGE = 't103.wallet.events';
export const OUTBOX_QUEUE = 't103.balance.audit';
export const BALANCE_CHANGED_ROUTING_KEY = 'balance.changed';
export const OUTBOX_CLAIM_LEASE_MS = 30_000;
export const OUTBOX_MAX_BACKOFF_MS = 60_000;
