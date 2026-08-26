import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CredentialsService } from '../credentials/credentials.service';
import { SlidingWindowLimiter } from '../utils/sliding-window-limiter';
import { CreateDeveloperKeyDto } from './dto/create-developer-key.dto';

// Public, unauthenticated (this is the whole point — a visitor to the
// marketing site clicks a button and gets a real credential with no signup
// flow). Every credential minted here is a real, working (apiKey, secretKey)
// pair against production call-service, so the only defense against abuse is
// this aggressive per-IP limit — deliberately much tighter than the
// connection-time limiter in ConnectionGuardService, which exists to protect
// against churn from an already-trusted service, not the general public.
const MAX_KEYS_PER_IP_PER_DAY = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000;

@ApiTags('developer')
@Controller('developer')
export class DeveloperController {
  private readonly limiter = new SlidingWindowLimiter(
    MAX_KEYS_PER_IP_PER_DAY,
    WINDOW_MS,
  );

  constructor(private readonly credentials: CredentialsService) {}

  @Post('api-keys')
  @ApiOperation({
    summary: 'Generate a demo (apiKey, secretKey) pair — public, rate-limited',
  })
  @ApiResponse({
    status: 201,
    description:
      'The created credential. secretKey is shown only in this response.',
  })
  async createKey(@Body() dto: CreateDeveloperKeyDto, @Req() req: Request) {
    if (!this.credentials.enabled) {
      throw new ServiceUnavailableException(
        'Credential storage is not configured on this instance.',
      );
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (!this.limiter.consume(ip)) {
      throw new HttpException(
        `Limit of ${MAX_KEYS_PER_IP_PER_DAY} demo keys per day reached — try again later.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const serviceName = dto.serviceName || `web-demo-${Date.now()}`;
    return this.credentials.createCredential(serviceName);
  }
}
