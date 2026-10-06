import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/**
 * Checks the `x-api-key` header against the API_KEY env var.
 * This is an abuse deterrent, not real authentication: a key shipped inside a
 * mobile app can be extracted. Rate limiting + size limits do the rest.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly log = new Logger('ApiKeyGuard');
  private readonly key = process.env.API_KEY ?? '';

  constructor() {
    if (!this.key) this.log.warn('API_KEY is empty — the API is open to everyone. Set it in production.');
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.key) return true;
    const req = ctx.switchToHttp().getRequest();
    const given = Buffer.from(String(req.headers['x-api-key'] ?? ''));
    const want = Buffer.from(this.key);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }
}
