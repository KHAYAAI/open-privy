import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'winston';
import { AppModule } from './app.module';
import { createLogger } from './common/logger';

async function bootstrap() {
  const logger = createLogger('Bootstrap');

  try {
    const app = await NestFactory.create(AppModule);

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    // CORS configuration
    const corsOrigins = (process.env.CORS_ORIGINS || '').split(',');
    app.enableCors({
      origin: corsOrigins,
      credentials: true,
    });

    const port = process.env.PORT || 3001;
    await app.listen(port);

    logger.info(`OpenPrivy API listening on port ${port}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  } catch (error) {
    logger.error('Failed to start application', error);
    process.exit(1);
  }
}

bootstrap();
