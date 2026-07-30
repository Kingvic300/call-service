import { Module } from '@nestjs/common';
import { CallsGateway } from './calls.gateway';
import { CallsController } from './calls.controller';
import { MeetingModule } from '../meeting/meeting.module';
import { WebsocketCoreModule } from '../websocket/websocket-core.module';

@Module({
  imports: [MeetingModule, WebsocketCoreModule],
  controllers: [CallsController],
  providers: [CallsGateway],
})
export class CallsModule {}
