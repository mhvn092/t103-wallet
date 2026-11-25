export interface IdempotentExecutionResultInterface<T> {
  replayed: boolean;
  statusCode: number;
  body: T;
}

export interface IdempotencyRouteConfigInterface {
  userField?: string;
  excludeUserFromHash?: boolean;
  scope: string;
  includeParam?: string;
}

export interface IdempotencyRequestContextInterface {
  key: string;
  scope: string;
  requestHash: string;
}
