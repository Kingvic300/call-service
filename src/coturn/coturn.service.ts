import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Generates short-lived TURN credentials using coturn's `use-auth-secret`
 * REST API mechanism (https://github.com/coturn/coturn/blob/master/docs/turn-rest-api.md):
 * username = "<expiry-unix-ts>:<userId>", credential = base64(HMAC-SHA1(secret, username)).
 * coturn independently derives the same credential at auth time, so no
 * shared per-user secret ever has to be provisioned or rotated — only the
 * one TURN_SECRET env var, which is never sent to the client (only the
 * derived, time-limited username/credential pair is).
 */
@Injectable()
export class CoturnService {
  private readonly host: string;
  private readonly port: number;
  private readonly tlsPort: number;
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService) {
    this.host = config.getOrThrow<string>('TURN_HOST');
    this.port = config.get<number>('TURN_PORT', 3478);
    this.tlsPort = config.get<number>('TURN_TLS_PORT', 5349);
    this.secret = config.getOrThrow<string>('TURN_SECRET');
    this.ttlSeconds = config.get<number>('TURN_CREDENTIAL_TTL_SECONDS', 86400);
  }

  generateIceServers(userId: string): IceServer[] {
    const expiry = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const username = `${expiry}:${userId}`;
    const credential = crypto.createHmac('sha1', this.secret).update(username).digest('base64');

    return [
      { urls: `stun:${this.host}:${this.port}` },
      { urls: `turn:${this.host}:${this.port}?transport=udp`, username, credential },
      { urls: `turn:${this.host}:${this.port}?transport=tcp`, username, credential },
      { urls: `turns:${this.host}:${this.tlsPort}?transport=tcp`, username, credential },
    ];
  }
}
