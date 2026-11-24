export interface IdempotentExecutionResult<T> {
  replayed: boolean;
  statusCode: number;
  body: T;
}

export type ExistingRecordOutcome<T> =
  { kind: 'REPLAY'; statusCode: number; body: T } | { kind: 'IN_PROGRESS' };

export interface IdempotencyRouteConfig {
  scope: string;
  includeParam?: string;
}

export interface IdempotencyRequestContext {
  key: string;
  scope: string;
  requestHash: string;
}
