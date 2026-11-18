import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('PaymentsMicroservice');
  const app = await NestFactory.create(AppModule);

  const tcpPort = parseInt(process.env.TCP_PORT ?? '4011', 10);

  app.connectMicroservice({
    transport: Transport.TCP,
    options: {
      host: '0.0.0.0',
      port: tcpPort,
    },
  });

  await app.startAllMicroservices();
  logger.log(`Payments Microservice TCP listener started on port ${tcpPort}`);

  await app.listen(3011);
  logger.log('Payments Microservice HTTP listener running on port 3011');
}

bootstrap().catch((err) => {
  console.error('Failed to start Payments Microservice:', err);
  process.exit(1);
});
