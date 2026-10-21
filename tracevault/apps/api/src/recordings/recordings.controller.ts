import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { clientIp, CurrentDevice, CurrentUser, DeviceAuth, DeviceOnly, Public, UserAuth } from '../common/auth-context';
import { parse, uuidParam } from '../common/http';
import { MAX_RECORDING_BYTES, RecordingsService } from './recordings.service';

const uploadSchema = z
  .object({
    kind: z.enum(['screen', 'audio']),
    mime_type: z.string().max(60),
    size_bytes: z.number().int().min(1).max(MAX_RECORDING_BYTES),
    sha256_hex: z.string().regex(/^[0-9a-fA-F]{64}$/),
    started_at: z.string().datetime({ offset: true }),
    stopped_at: z.string().datetime({ offset: true }),
    consent: z
      .object({
        consenting_party: z.string().trim().min(1).max(120),
        consent_text: z.string().trim().min(10).max(2000),
        os_permission: z.enum(['granted', 'denied', 'not_required']),
        indicator_shown: z.boolean(),
        consented_at: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

const ticketQuery = z.object({ exp: z.string().max(20), sig: z.string().max(100) });

@ApiTags('recordings')
@Controller('v1')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @DeviceOnly()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('recordings/upload-url')
  async uploadUrl(@CurrentDevice() device: DeviceAuth, @Body() body: unknown) {
    return this.recordings.createUpload(device, parse(uploadSchema, body));
  }

  @DeviceOnly()
  @Post('recordings/:id/complete')
  @HttpCode(200)
  async complete(@CurrentDevice() device: DeviceAuth, @Param('id') id: string) {
    return this.recordings.complete(device, parse(uuidParam, id));
  }

  @Get('recordings')
  async list(@CurrentUser() user: UserAuth) {
    return { items: await this.recordings.list(user) };
  }

  @Post('recordings/:id/download-url')
  async downloadUrl(@CurrentUser() user: UserAuth, @Param('id') id: string, @Req() req: Request) {
    return this.recordings.createDownload(user, parse(uuidParam, id), clientIp(req));
  }

  @Delete('recordings/:id')
  async remove(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    await this.recordings.remove(user, parse(uuidParam, id));
    return { ok: true };
  }

  /** Signed, single-use, short-lived. The signature is the only credential. */
  @Public()
  @Put('storage/upload/:ticket')
  async upload(@Param('ticket') ticket: string, @Query() q: unknown, @Req() req: Request) {
    const { exp, sig } = parse(ticketQuery, q);
    return this.recordings.receiveUpload(ticket, exp, sig, req.headers['content-type'], req);
  }

  @Public()
  @Get('storage/download/:ticket')
  async download(@Param('ticket') ticket: string, @Query() q: unknown, @Res() res: Response) {
    const { exp, sig } = parse(ticketQuery, q);
    const file = await this.recordings.openDownload(ticket, exp, sig);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'attachment');
    file.stream.on('error', () => res.destroy());
    file.stream.pipe(res);
  }
}
