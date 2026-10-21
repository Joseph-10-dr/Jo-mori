import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { z, ZodTypeAny } from 'zod';

/** Validate untrusted input; throws 400 with the first few issues. */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new BadRequestException({
      message: 'Request validation failed',
      details: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export const uuidParam = z.string().uuid();

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const obj = typeof body === 'string' ? { message: body } : (body as Record<string, unknown>);
      res.status(status).json({
        statusCode: status,
        error: HttpStatus[status] ?? 'Error',
        message: obj.message ?? exception.message,
        ...(obj.details ? { details: obj.details } : {}),
      });
      return;
    }
    // body-parser errors (oversized / malformed JSON)
    const e = exception as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ statusCode: 413, error: 'Payload Too Large', message: 'Request body too large' });
      return;
    }
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ statusCode: 400, error: 'Bad Request', message: 'Malformed JSON' });
      return;
    }
    const errorId = randomUUID();
    // Log the error class and message only; never request bodies or headers.
    this.logger.error(`[${errorId}] ${req.method} ${req.path}: ${(exception as Error)?.message}`);
    res.status(500).json({
      statusCode: 500,
      error: 'Internal Server Error',
      message: `Unexpected error. Reference ${errorId}`,
    });
  }
}
