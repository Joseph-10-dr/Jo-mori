import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { eventBatchSchema } from '@tracevault/event-schema';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../common/audit.service';
import {
  CurrentDevice,
  CurrentUser,
  DeviceAuth,
  DeviceOnly,
  UserAuth,
} from '../common/auth-context';
import { parse, uuidParam } from '../common/http';
import { eventFilterSchema, EventsService } from './events.service';

function csvCell(v: unknown): string {
  let s =
    v === null || v === undefined
      ? ''
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v instanceof Date ? v.toISOString() : v);
  // Neutralise spreadsheet formula injection (OWASP CSV injection guidance).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

@ApiTags('events')
@Controller('v1/events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  @DeviceOnly()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('batch')
  @HttpCode(200)
  async batch(@CurrentDevice() device: DeviceAuth, @Body() body: unknown, @Req() req: Request) {
    const dto = parse(eventBatchSchema, body);
    const bytes = Number(req.headers['content-length'] ?? 0) || JSON.stringify(body).length;
    return this.events.ingest(device, dto.events, bytes);
  }

  @Get()
  async search(@CurrentUser() user: UserAuth, @Query() q: unknown) {
    return this.events.search(user, parse(eventFilterSchema, q));
  }

  @Get('stats')
  async stats(@CurrentUser() user: UserAuth, @Query() q: unknown) {
    const { bucket, ...rest } = parse(
      eventFilterSchema.extend({ bucket: z.enum(['hour', 'day']).default('day') }),
      q,
    );
    return this.events.stats(user, rest, bucket);
  }

  @Get('export')
  async export(@CurrentUser() user: UserAuth, @Query() q: unknown, @Res() res: Response) {
    const { format, ...f } = parse(
      eventFilterSchema.extend({ format: z.enum(['csv', 'json']).default('csv') }),
      q,
    );
    const rows = await this.events.exportRows(user, f);
    await this.audit.record({
      action: 'events.exported',
      actorUserId: user.userId,
      subjectUserId: user.userId,
      organizationId: f.organization_id ?? null,
      details: { rows: rows.length, format, filters: { ...f, cursor: undefined } },
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (format === 'json') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="tracevault-events-${stamp}.json"`,
      );
      res.json({ exported_at: new Date().toISOString(), count: rows.length, events: rows });
      return;
    }
    const cols = [
      'id',
      'event_id',
      'occurred_at',
      'received_at',
      'delayed',
      'device_name',
      'device_id',
      'event_type',
      'severity',
      'source',
      'metadata',
    ];
    const lines = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tracevault-events-${stamp}.csv"`);
    res.send(lines.join('\n'));
  }

  @Get(':id')
  async get(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    return this.events.get(user, parse(uuidParam, id));
  }
}
