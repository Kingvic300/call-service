import { WsException } from '@nestjs/websockets';
import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

/**
 * Validates a raw socket payload against a class-validator DTO. Used instead
 * of Nest's HTTP-oriented ValidationPipe so every @SubscribeMessage handler
 * gets the same "reject malformed payloads" guarantee the spec requires
 * ("Protect against malformed socket payloads") without extra pipe wiring.
 */
export function validateWsPayload<T extends object>(
  cls: ClassConstructor<T>,
  payload: unknown,
): T {
  if (typeof payload !== 'object' || payload === null) {
    throw new WsException('Payload must be an object');
  }

  const instance = plainToInstance(cls, payload, {
    excludeExtraneousValues: false,
  });
  const errors = validateSync(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });

  if (errors.length > 0) {
    const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    throw new WsException(`Invalid payload: ${messages.join(', ')}`);
  }

  return instance;
}
