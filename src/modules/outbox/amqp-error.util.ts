export function sanitizeBrokerError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/amqps?:\/\/[^\s]+/gi, '[REDACTED_AMQP_URI]');
}
