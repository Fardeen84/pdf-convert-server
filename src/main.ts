import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });
  // Behind nginx / a cloud load balancer: use the real client IP for rate limiting.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`Mrig convert server listening on :${port}`, 'Bootstrap');
}
bootstrap();
