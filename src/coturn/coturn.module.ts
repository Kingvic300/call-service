import { Global, Module } from '@nestjs/common';
import { CoturnService } from './coturn.service';

@Global()
@Module({
  providers: [CoturnService],
  exports: [CoturnService],
})
export class CoturnModule {}
