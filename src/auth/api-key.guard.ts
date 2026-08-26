import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';

/**
 * Guards REST endpoints called server-to-server by an integrating backend
 * (POST /meetings, /kick, /mute, ...). These are never called directly by
 * browsers/mobile clients, so a service (apiKey, secretKey) pair is used
 * instead of a user credential.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = request.header('x-api-key');
    const secretKey = request.header('x-secret-key');

    if (!(await this.authService.verifyApiKey(apiKey, secretKey))) {
      throw new UnauthorizedException(
        'Missing or invalid X-API-Key/X-Secret-Key headers',
      );
    }

    return true;
  }
}
