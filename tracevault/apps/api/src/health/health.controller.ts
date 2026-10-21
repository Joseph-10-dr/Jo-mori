import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../config';
import { Public } from '../common/auth-context';
import { parse } from '../common/http';
import { Db } from '../db/db.service';

@ApiTags('health')
@Controller('v1')
export class HealthController {
  constructor(
    private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @SkipThrottle()
  @Get('health')
  async health() {
    try {
      await this.db.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ message: 'database unavailable' });
    }
    return {
      status: 'ok',
      version: process.env.npm_package_version ?? '0.1.0',
      time: new Date().toISOString(),
    };
  }

  /** Development only: read messages that would have been emailed. Disabled in production. */
  @Public()
  @Get('dev/outbox')
  async outbox(@Query() q: unknown) {
    if (!this.config.devOutboxEnabled) throw new NotFoundException();
    const { to } = parse(z.object({ to: z.string().email().optional() }), q);
    return {
      items: await this.db.query(
        `SELECT id, to_email, subject, body, status, created_at FROM email_outbox
          WHERE ($1::text IS NULL OR to_email = $1) ORDER BY created_at DESC LIMIT 50`,
        [to ?? null],
      ),
    };
  }
}
