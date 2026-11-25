import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { isRecord } from '../../common/filters/exception-response.util.js';
import { matchesSecret } from '../../common/utils/secret-comparison.util.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { IDEMPOTENCY_ROUTE_META } from '../idempotency/idempotency.decorator.js';
import type { IdempotencyRouteConfigInterface } from '../idempotency/idempotency.interface.js';

const AUTHENTICATED_USER = Symbol('wallet-authenticated-user');
type WalletRequest = Request & { [AUTHENTICATED_USER]?: string };

export const WalletPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined =>
    ctx.switchToHttp().getRequest<WalletRequest>()[AUTHENTICATED_USER],
);

@Injectable()
export class WalletAccessGuard implements CanActivate {
  constructor(
    private readonly _config: ConfigService<EnvConfig, true>,
    private readonly _reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const key = this._config.get('WALLET_GATEWAY_KEY', { infer: true });
    if (!key && this._config.get('APP_ENV', { infer: true }) === 'local') {
      return true;
    }
    if (!key) {
      throw new DomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Wallet gateway access is not configured',
      );
    }

    const req = context.switchToHttp().getRequest<WalletRequest>();
    const userId = req.header('x-wallet-user-id')?.trim();
    if (
      !matchesSecret(key, req.header('x-wallet-gateway-key')) ||
      !userId ||
      userId.length > 128
    ) {
      throw new DomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Wallet gateway credentials are required',
      );
    }

    const route = this._reflector.get<
      IdempotencyRouteConfigInterface | undefined
    >(IDEMPOTENCY_ROUTE_META, context.getHandler());
    const body: unknown = req.body;
    const requestedUser = route?.userField
      ? this._bodyUserId(body, route.userField)
      : req.params.userId;
    if (
      (requestedUser !== undefined || route?.userField) &&
      (typeof requestedUser !== 'string' || requestedUser.trim() !== userId)
    ) {
      throw new DomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Wallet user does not match the authenticated principal',
      );
    }

    req[AUTHENTICATED_USER] = userId;
    return true;
  }

  private _bodyUserId(body: unknown, field: string): unknown {
    return isRecord(body) && Object.hasOwn(body, field)
      ? body[field]
      : undefined;
  }
}
