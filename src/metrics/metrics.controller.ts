import { Controller, Get, Header, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { MetricsService } from './metrics.service';

@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-cache')
  @ApiOperation({
    summary: 'Prometheus metrics',
    description: 'Plain-text exposition format, not JSON — for a scraper, not interactive use.',
  })
  async get(@Res() res: Response): Promise<void> {
    const { contentType, body } = await this.metrics.getMetrics();
    res.setHeader('Content-Type', contentType);
    res.send(body);
  }
}
