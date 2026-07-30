import { Controller, Get, Header, Res } from '@nestjs/common';
import { Response } from 'express';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-cache')
  async get(@Res() res: Response): Promise<void> {
    const { contentType, body } = await this.metrics.getMetrics();
    res.setHeader('Content-Type', contentType);
    res.send(body);
  }
}
