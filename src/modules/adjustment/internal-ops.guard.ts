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
import type { EnvConfig } from '../../config/env.validation.js';

function normalizeIp(rawIp: string | undefined): string {
  if (!rawIp) {
    return '';
  }
  return rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
}

@Injectable()
export class InternalOpsGuard implements CanActivate {
  constructor(private readonly config: ConfigService<EnvConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    const allowedIpsRaw = this.config.get('INTERNAL_ALLOWED_IPS', {
      infer: true,
    });
    if (allowedIpsRaw) {
      const allowedIps = new Set(
        allowedIpsRaw
          .split(',')
          .map((ip) => normalizeIp(ip.trim()))
          .filter(Boolean),
      );
      const clientIp = normalizeIp(req.ip);
      if (!allowedIps.has(clientIp)) {
        throw new DomainException(
          HttpStatus.FORBIDDEN,
          ErrorCode.FORBIDDEN,
          'Client IP is not authorized for internal operations',
        );
      }
    }

    const expectedKey = this.config.get('INTERNAL_API_KEY', { infer: true });
    if (expectedKey) {
      const providedKey = req.header('x-internal-api-key') ?? '';
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

    return true;
  }
}
