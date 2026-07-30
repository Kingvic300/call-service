import { Module } from '@nestjs/common';
import { ScreenShareService } from './screen-share.service';

@Module({
  providers: [ScreenShareService],
  exports: [ScreenShareService],
})
export class ScreenShareModule {}
