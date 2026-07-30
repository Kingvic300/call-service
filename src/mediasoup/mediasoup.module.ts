import { Global, Module } from '@nestjs/common';
import { RouterManagerService } from './router-manager.service';
import { TransportService } from './transport.service';
import { ProducerConsumerService } from './producer-consumer.service';

@Global()
@Module({
  providers: [RouterManagerService, TransportService, ProducerConsumerService],
  exports: [RouterManagerService, TransportService, ProducerConsumerService],
})
export class MediasoupModule {}
