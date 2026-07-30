import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';

/**
 * Guards REST endpoints called server-to-server by the existing NestJS
 * backend (POST /meetings, /kick, /mute, ...). These are never called
 * directly by browsers/mobile clients, so a shared service API key is used
 * instead of a user JWT.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = request.header('x-api-key');

    if (!this.authService.verifyApiKey(apiKey)) {
      throw new UnauthorizedException('Missing or invalid X-API-Key header');
    }

    return true;
  }
}
