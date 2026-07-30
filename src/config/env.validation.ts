import { plainToInstance, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min, validateSync } from 'class-validator';

class EnvironmentVariables {
  @IsOptional()
  @IsIn(['development', 'production', 'test'])
  NODE_ENV = 'development';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 4000;

  @IsOptional()
  @IsIn(['fatal', 'error', 'warn', 'log', 'debug', 'verbose'])
  LOG_LEVEL = 'log';

  @IsString()
  JWT_SECRET!: string;

  @IsOptional()
  @IsIn(['HS256', 'RS256'])
  JWT_ALGORITHM = 'HS256';

  @IsString()
  INTERNAL_API_KEYS!: string;

  @IsOptional()
  @IsString()
  CORS_ORIGIN = '*';

  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(64)
  MEDIASOUP_NUM_WORKERS?: number;

  @IsOptional()
  @IsIn(['debug', 'warn', 'error', 'none'])
  MEDIASOUP_LOG_LEVEL = 'warn';

  // Fallback range for the rare case a transport is created without a
  // WebRtcServer — not exercised on the normal path (see MEDIASOUP_WEBRTC_PORT).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  MEDIASOUP_MIN_PORT = 40000;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  MEDIASOUP_MAX_PORT = 40009;

  @IsOptional()
  @IsString()
  MEDIASOUP_LISTEN_IP = '0.0.0.0';

  @IsString()
  MEDIASOUP_ANNOUNCED_IP!: string;

  // Every WebRtcTransport on a given worker shares this one UDP+TCP port
  // (mediasoup's WebRtcServer) — worker N listens on WEBRTC_PORT + N, so the
  // range to actually open is [port, port + MEDIASOUP_NUM_WORKERS - 1].
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  MEDIASOUP_WEBRTC_PORT = 44000;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  MEDIASOUP_INITIAL_AVAILABLE_OUTGOING_BITRATE = 800000;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  MEDIASOUP_MAX_INCOMING_BITRATE = 1500000;

  @IsString()
  TURN_HOST!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  TURN_PORT = 3478;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  TURN_TLS_PORT = 5349;

  @IsString()
  TURN_SECRET!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  TURN_CREDENTIAL_TTL_SECONDS = 86400;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  CHAT_HISTORY_LIMIT = 200;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  WS_RATE_LIMIT_POINTS = 30;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  WS_RATE_LIMIT_DURATION_MS = 1000;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  CONNECTION_RATE_LIMIT_PER_MINUTE = 60;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  DISCONNECT_GRACE_PERIOD_MS = 10000;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const messages = errors
      .map((err) => Object.values(err.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${messages}`);
  }

  return validated;
}

export type AppEnv = EnvironmentVariables;
