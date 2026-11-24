export interface IdempotentExecutionResult<T> {
  replayed: boolean;
  statusCode: number;
  body: T;
}

export type ExistingRecordOutcome<T> =
  { kind: 'REPLAY'; statusCode: number; body: T } | { kind: 'IN_PROGRESS' };
