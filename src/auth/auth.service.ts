import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';

interface BackendJwtPayload {
  sub?: string;
  id?: string;
  userId?: string;
  name?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
  picture?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtSecret: string;
  private readonly jwtAlgorithm: jwt.Algorithm;
  private readonly apiKeys: Set<string>;

  constructor(private readonly config: ConfigService) {
    this.jwtSecret = this.config.getOrThrow<string>('JWT_SECRET');
    this.jwtAlgorithm = this.config.get<jwt.Algorithm>('JWT_ALGORITHM', 'HS256');
    this.apiKeys = new Set(
      this.config
        .getOrThrow<string>('INTERNAL_API_KEYS')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean),
    );

    if (this.apiKeys.size === 0) {
      throw new Error('INTERNAL_API_KEYS must contain at least one key');
    }
  }

  /**
   * Verifies a user-issued JWT from the existing NestJS backend. Never
   * accepts client-supplied role/permission claims — role is always resolved
   * server-side from meeting.hostId / promotions tracked by ParticipantService.
   */
  verifyUserToken(token: string): AuthenticatedUser {
    let payload: BackendJwtPayload;
    try {
      payload = jwt.verify(token, this.jwtSecret, {
        algorithms: [this.jwtAlgorithm],
      }) as BackendJwtPayload;
    } catch (err) {
      throw new UnauthorizedException(
        `Invalid token: ${err instanceof Error ? err.message : 'verification failed'}`,
      );
    }

    const id = payload.sub ?? payload.id ?? payload.userId;
    if (!id) {
      throw new UnauthorizedException('Token payload missing subject/user id');
    }

    return {
      id,
      displayName: payload.name ?? payload.displayName ?? payload.email ?? id,
      avatarUrl: payload.avatarUrl ?? payload.picture,
    };
  }

  /** Constant-time API key check for backend-to-call-service REST calls. */
  verifyApiKey(candidate: string | undefined): boolean {
    if (!candidate) return false;

    for (const key of this.apiKeys) {
      if (timingSafeEqualStrings(candidate, key)) return true;
    }

    this.logger.warn('Rejected request with invalid internal API key');
    return false;
  }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers to avoid a cheap
    // length-based timing oracle.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
