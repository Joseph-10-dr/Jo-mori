import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentUser, UserAuth } from '../common/auth-context';
import { parse } from '../common/http';
import { SummaryService } from './summary.service';

@ApiTags('summaries')
@Controller('v1/summaries')
export class SummariesController {
  constructor(private readonly summaries: SummaryService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  @HttpCode(200)
  async create(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    const dto = parse(
      z
        .object({
          question: z.string().trim().min(3).max(500),
          device_id: z.string().uuid().optional(),
          alert_id: z.string().uuid().optional(),
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
        })
        .strict(),
      body,
    );
    return this.summaries.summarize(user, dto);
  }
}
