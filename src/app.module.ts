import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConvertController } from './convert/convert.controller';
import { ConvertService } from './convert/convert.service';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MIN ?? 20) }]),
  ],
  controllers: [ConvertController],
  providers: [ConvertService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
