import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import mongoose, { Connection, Model } from 'mongoose';
import { ApiCredentialDoc, ApiCredentialSchema } from './api-credential.schema';

const BCRYPT_ROUNDS = 12;

/**
 * DB-backed (apiKey, secretKey) credentials for services integrating with
 * call-service beyond the ones already configured statically via
 * SERVICE_CREDENTIALS (see AuthService) — lets a new integration be added,
 * or an existing one rotated/revoked, without redeploying call-service
 * itself. Mirrors RedisService's shape: everything here is a no-op when
 * MONGO_URI isn't set, so this stays a purely additive feature, never a
 * hard dependency for the rest of the service to boot or handle calls.
 */
@Injectable()
export class CredentialsService implements OnModuleDestroy {
  private readonly logger = new Logger(CredentialsService.name);
  private readonly connection?: Connection;
  private readonly model?: Model<ApiCredentialDoc>;

  constructor(config: ConfigService) {
    const uri = config.get<string>('MONGO_URI');
    if (!uri) return;

    this.connection = mongoose.createConnection(uri);
    this.connection.on('error', (err: Error) =>
      this.logger.error(`MongoDB connection error: ${err.message}`),
    );
    this.connection.once('open', () =>
      this.logger.log(
        'Connected to MongoDB — DB-backed API credentials enabled',
      ),
    );
    this.model = this.connection.model<ApiCredentialDoc>(
      'ApiCredential',
      ApiCredentialSchema,
    );
  }

  get enabled(): boolean {
    return this.model !== undefined;
  }

  /** Constant-time-ish (bcrypt.compare is already timing-safe on the hash
   *  comparison) verification against a stored credential. Returns false,
   *  not an error, for "not found" — same shape as a wrong secret, so this
   *  never leaks which apiKeys exist. */
  async verify(apiKey: string, secretKey: string): Promise<boolean> {
    if (!this.model) return false;

    const doc = await this.model
      .findOne({ apiKey, active: true })
      .lean()
      .exec()
      .catch((err: Error) => {
        this.logger.error(`Credential lookup failed: ${err.message}`);
        return null;
      });
    if (!doc) return false;

    return bcrypt.compare(secretKey, doc.secretKeyHash);
  }

  /** Registers a new integrating service. Returns the plaintext secretKey —
   *  the only time it's ever available; only the bcrypt hash is persisted. */
  async createCredential(
    serviceName: string,
  ): Promise<{ apiKey: string; secretKey: string }> {
    if (!this.model) {
      throw new Error('CredentialsService: MONGO_URI not configured');
    }

    const apiKey = `nlx_key_${crypto.randomBytes(12).toString('hex')}`;
    const secretKey = `nlx_secret_${crypto.randomBytes(20).toString('hex')}`;
    const secretKeyHash = await bcrypt.hash(secretKey, BCRYPT_ROUNDS);

    await this.model.create({
      apiKey,
      secretKeyHash,
      serviceName,
      active: true,
    });
    return { apiKey, secretKey };
  }

  async revoke(apiKey: string): Promise<void> {
    await this.model?.updateOne({ apiKey }, { active: false }).exec();
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }
}
