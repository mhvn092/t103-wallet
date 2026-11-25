export type ExistingRecordOutcome<T> =
  { kind: 'REPLAY'; statusCode: number; body: T } | { kind: 'IN_PROGRESS' };
