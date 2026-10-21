import { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import helmet from 'helmet';
import { LIMITS } from '@tracevault/event-schema';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/http';
import { requestLogger } from './common/request-logger';
import { AppConfig } from './config';
import { migrate } from './db/migrate';

export async function createApp(
  config: AppConfig,
  opts: { logger?: LoggerService | false } = {},
): Promise<INestApplication> {
  await migrate(config.databaseUrl);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bodyParser: false,
    logger: opts.logger ?? ['log', 'warn', 'error'],
  });
  // Behind a TLS-terminating proxy in production; trust it for client IPs.
  app.set('trust proxy', config.env === 'production' ? 1 : 'loopback');
  app.use(helmet());
  app.use(cookieParser());
  app.use(json({ limit: LIMITS.maxBatchBytes }));
  app.use(requestLogger);
  app.enableCors({
    origin: [config.webOrigin],
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-tracevault-csrf', 'x-tracevault-client'],
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('TraceVault API')
    .setDescription('Versioned REST API. See docs/api.md for request/response schemas.')
    .setVersion('1')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), {
    jsonDocumentUrl: 'docs/openapi.json',
  });
  return app;
}
