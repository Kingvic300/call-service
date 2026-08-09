import { Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Forwards a meeting-scoped REST request to whichever instance actually
 * owns that meeting, when it isn't this one — see MeetingOwnershipMiddleware.
 * Plain `fetch` rather than a new HTTP client dependency; these are
 * trusted instance-to-instance calls carrying the same X-API-Key the
 * original caller (the real backend) already presented, so ApiKeyGuard on
 * the receiving instance authorizes it exactly as if it had landed there
 * directly.
 */
@Injectable()
export class InstanceForwarderService {
  private readonly logger = new Logger(InstanceForwarderService.name);

  async forward(targetBaseUrl: string, req: Request, res: Response): Promise<void> {
    const url = `${targetBaseUrl}${req.originalUrl}`;
    const apiKey = req.header('x-api-key');

    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
      });

      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
      res.send(text);
    } catch (err) {
      this.logger.error(`Failed to forward ${req.method} ${req.originalUrl} to ${targetBaseUrl}: ${
        err instanceof Error ? err.message : err
      }`);
      res.status(502).json({ statusCode: 502, message: 'Failed to reach the meeting\'s owning instance' });
    }
  }
}
