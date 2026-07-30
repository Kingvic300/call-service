import { Global, Module } from '@nestjs/common';
import { RealtimeBroadcaster } from './realtime-broadcaster.service';

@Global()
@Module({
  providers: [RealtimeBroadcaster],
  exports: [RealtimeBroadcaster],
})
export class RealtimeBroadcasterModule {}
