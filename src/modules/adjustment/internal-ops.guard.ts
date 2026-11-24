import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { DomainException } from '../../common/errors/domain.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { normalizeIpAddress } from '../../common/utils/ip-address.util.js';
import type { EnvConfig } from '../../config/env.validation.js';

@Injectable()
export class InternalOpsGuard implements CanActivate {
  constructor(
    private readonly _configService: ConfigService<EnvConfig, true>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const allowedIpsRaw = this._configService.get('INTERNAL_ALLOWED_IPS', {
      infer: true,
    });
    const expectedKey = this._configService.get('INTERNAL_API_KEY', {
      infer: true,
    });
    const appEnv = this._configService.get('APP_ENV', { infer: true });
    const nodeEnv = this._configService.get('NODE_ENV', { infer: true });
    const allowUnauthInternalOps =
      this._configService.get('ALLOW_UNAUTHENTICATED_INTERNAL_OPS', {
        infer: true,
      }) ?? false;

    if (
      !expectedKey &&
      (appEnv === 'production' ||
        (nodeEnv === 'production' && !allowUnauthInternalOps))
    ) {
      throw new DomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Internal operations require INTERNAL_API_KEY in production',
      );
    }

    if (allowedIpsRaw) {
      this._assertIpAllowed(allowedIpsRaw, req.ip);
    }

    if (expectedKey) {
      this._assertApiKeyValid(expectedKey, req.header('x-internal-api-key'));
    }

    return true;
  }

  private _assertIpAllowed(
    allowedIpsRaw: string,
    remoteIp: string | undefined,
  ): void {
    const allowedIps = new Set(
      allowedIpsRaw
        .split(',')
        .map((ip) => normalizeIpAddress(ip.trim()))
        .filter(Boolean),
    );
    const clientIp = normalizeIpAddress(remoteIp);
    if (!allowedIps.has(clientIp)) {
      throw new DomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Client IP is not authorized for internal operations',
      );
    }
  }

  private _assertApiKeyValid(
    expectedKey: string,
    providedHeader: string | undefined,
  ): void {
    const providedKey = providedHeader ?? '';
    const expectedBuf = Buffer.from(expectedKey, 'utf8');
    const providedBuf = Buffer.from(providedKey, 'utf8');
    if (
      expectedBuf.byteLength !== providedBuf.byteLength ||
      !timingSafeEqual(expectedBuf, providedBuf)
    ) {
      throw new DomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Invalid or missing X-Internal-Api-Key',
      );
    }
  }
}
