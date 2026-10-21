import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('HTTP');

/**
 * Logs method, path (query string dropped — signed URLs carry signatures there),
 * status and duration. Never logs headers, cookies or bodies (OWASP logging guidance).
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const path = req.originalUrl
      .split('?')[0]
      .replace(/\/storage\/(upload|download)\/[^/]+/, '/storage/$1/:ticket');
    logger.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
}
