import {
  IsBoolean,
  IsIn,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class JoinRoomDto {
  @IsString()
  meetingId!: string;
}

export class LeaveRoomDto {
  @IsString()
  meetingId!: string;
}

export class CreateTransportDto {
  @IsString()
  meetingId!: string;

  @IsIn(['send', 'recv'])
  direction!: 'send' | 'recv';
}

export class DtlsParametersDto {
  @IsObject()
  @IsNotEmptyObject()
  dtlsParameters!: Record<string, unknown>;
}

export class ConnectTransportDto {
  @IsString()
  meetingId!: string;

  @IsString()
  transportId!: string;

  @IsObject()
  @IsNotEmptyObject()
  dtlsParameters!: Record<string, unknown>;
}

export class ProduceDto {
  @IsString()
  meetingId!: string;

  @IsString()
  transportId!: string;

  @IsIn(['audio', 'video'])
  kind!: 'audio' | 'video';

  @IsObject()
  @IsNotEmptyObject()
  rtpParameters!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  appData?: Record<string, unknown>;
}

export class ConsumeDto {
  @IsString()
  meetingId!: string;

  @IsString()
  transportId!: string;

  @IsString()
  producerId!: string;

  @IsObject()
  @IsNotEmptyObject()
  rtpCapabilities!: Record<string, unknown>;
}

export class ProducerIdDto {
  @IsString()
  meetingId!: string;

  @IsString()
  producerId!: string;
}

export class ConsumerIdDto {
  @IsString()
  meetingId!: string;

  @IsString()
  consumerId!: string;
}

export class TransportIdDto {
  @IsString()
  meetingId!: string;

  @IsString()
  transportId!: string;
}

export class ReactionDto {
  @IsString()
  meetingId!: string;

  @IsString()
  emoji!: string;
}

export class ChatMessageDto {
  @IsString()
  meetingId!: string;

  @IsString()
  text!: string;
}

export class TargetPeerDto {
  @IsString()
  meetingId!: string;

  @IsString()
  targetUserId!: string;
}

export class SetFeatureDto {
  @IsString()
  meetingId!: string;

  @IsIn(['chat', 'reactions', 'screenShare'])
  feature!: 'chat' | 'reactions' | 'screenShare';

  @IsBoolean()
  enabled!: boolean;
}

export class MeetingIdOnlyDto {
  @IsString()
  meetingId!: string;
}
