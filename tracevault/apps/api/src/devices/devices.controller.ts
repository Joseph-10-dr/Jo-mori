import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { EVENT_SOURCES } from '@tracevault/event-schema';
import type { Request } from 'express';
import { z } from 'zod';
import {
  clientIp,
  CurrentDevice,
  CurrentUser,
  DeviceAuth,
  DeviceOnly,
  Public,
  UserAuth,
} from '../common/auth-context';
import { parse, uuidParam } from '../common/http';
import { Db } from '../db/db.service';
import { RecordingsService } from '../recordings/recordings.service';
import { DevicesService } from './devices.service';

const deviceName = z.string().trim().min(1).max(80);
const permissionState = z.enum(['granted', 'denied', 'unsupported', 'unknown']);

/** Official lost-device and account-security pages. TraceVault links to them; it cannot lock, wipe or locate devices itself. */
const RECOVERY_LINKS: Record<string, { label: string; url: string }[]> = {
  windows: [
    {
      label: 'Microsoft: Find and lock a lost Windows device',
      url: 'https://account.microsoft.com/devices',
    },
  ],
  macos: [{ label: 'Apple: Find My (lock or erase a Mac)', url: 'https://www.icloud.com/find' }],
  ios: [{ label: 'Apple: Find My (lost iPhone)', url: 'https://www.icloud.com/find' }],
  android: [{ label: 'Google: Find My Device', url: 'https://www.google.com/android/find' }],
  common: [
    {
      label: 'Google account: sign out of a lost device',
      url: 'https://myaccount.google.com/device-activity',
    },
    {
      label: 'Microsoft account: security & sign-in activity',
      url: 'https://account.microsoft.com/security',
    },
    { label: 'Apple ID: remove a device', url: 'https://account.apple.com/account/manage' },
  ],
};

@ApiTags('devices')
@Controller('v1/devices')
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly recordings: RecordingsService,
    private readonly db: Db,
  ) {}

  @Post('enrollment-codes')
  async enrollmentCode(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    const dto = parse(z.object({ organization_id: z.string().uuid().nullish() }), body ?? {});
    return this.devices.createEnrollmentCode(user, dto.organization_id ?? null);
  }

  /** Called by the device agent with the code a signed-in user created. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  async register(@Body() body: unknown, @Req() req: Request) {
    const dto = parse(
      z
        .object({
          enrollment_code: z.string().trim().min(10).max(20),
          name: deviceName,
          platform: z.enum(EVENT_SOURCES),
          os_version: z.string().trim().max(100).optional(),
          agent_version: z.string().trim().max(40).optional(),
        })
        .strict(),
      body,
    );
    return this.devices.register({
      code: dto.enrollment_code,
      name: dto.name,
      platform: dto.platform,
      osVersion: dto.os_version,
      agentVersion: dto.agent_version,
      ip: clientIp(req),
    });
  }

  // ---- device-authenticated (declared before :id routes) ----
  @DeviceOnly()
  @Get('self')
  async self(@CurrentDevice() device: DeviceAuth) {
    return this.db.one(
      `SELECT id, name, platform, status, monitoring_status, last_sync_at, registered_at FROM devices WHERE id = $1`,
      [device.deviceId],
    );
  }

  @DeviceOnly()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('self/heartbeat')
  @HttpCode(200)
  async heartbeat(@CurrentDevice() device: DeviceAuth, @Body() body: unknown) {
    const dto = parse(
      z
        .object({
          monitoring_status: z.enum(['active', 'paused', 'unavailable', 'disabled']),
          permissions: z.record(z.string().regex(/^[a-z_]{1,40}$/), permissionState).default({}),
          startup_enabled: z.boolean().default(false),
          agent_version: z.string().max(40).optional(),
          os_version: z.string().max(100).optional(),
          queued_events: z.number().int().min(0).max(1_000_000).default(0),
          consecutive_upload_failures: z.number().int().min(0).max(100_000).default(0),
          last_error: z.string().max(300).optional(),
        })
        .strict(),
      body,
    );
    await this.devices.heartbeat(device.deviceId, dto);
    return { ok: true, server_time: new Date().toISOString() };
  }

  @DeviceOnly()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('self/rotate-credential')
  async rotate(@CurrentDevice() device: DeviceAuth) {
    return this.devices.rotateCredential(device.deviceId, device.credentialId);
  }

  // ---- user-authenticated ----
  @Get()
  async list(@CurrentUser() user: UserAuth, @Query() q: unknown) {
    const f = parse(
      z.object({
        status: z.enum(['active', 'revoked']).optional(),
        organization_id: z.string().uuid().optional(),
      }),
      q,
    );
    return {
      items: await this.devices.list(user, { status: f.status, organizationId: f.organization_id }),
    };
  }

  @Get(':id')
  async get(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    return (await this.devices.getVisible(user, parse(uuidParam, id))).device;
  }

  @Patch(':id')
  async rename(@CurrentUser() user: UserAuth, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(z.object({ name: deviceName }).strict(), body);
    await this.devices.rename(user, parse(uuidParam, id), dto.name);
    return (await this.devices.getVisible(user, id)).device;
  }

  @Post(':id/revoke')
  @HttpCode(200)
  async revoke(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    await this.devices.revoke(user, parse(uuidParam, id));
    return { ok: true };
  }

  @Post(':id/report-lost')
  @HttpCode(200)
  async reportLost(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    await this.devices.revoke(user, parse(uuidParam, id), 'reported_lost');
    return { ok: true, recovery: await this.recovery(user, id) };
  }

  @Get(':id/recovery')
  async recovery(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    const r = await this.devices.recovery(user, parse(uuidParam, id));
    return {
      ...r,
      official_links: [...(RECOVERY_LINKS[r.device.platform] ?? []), ...RECOVERY_LINKS.common],
      limitations:
        'TraceVault can show what was uploaded before the device went missing and revoke its access. It cannot locate, lock, unlock or erase the device; use the official service for your platform. Events that were still queued on the device and never uploaded are not available.',
    };
  }

  @Delete(':id')
  async remove(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    const deviceId = parse(uuidParam, id);
    const d = await this.devices.getManageable(user, deviceId);
    await this.recordings.deleteObjectsForDevice(d.id);
    await this.devices.remove(user, deviceId);
    return { ok: true };
  }
}
