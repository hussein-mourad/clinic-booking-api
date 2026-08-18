import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createApp } from './app.factory';

async function bootstrap() {
  const app = await createApp();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Clinic Booking API')
    .setDescription('REST API for clinic appointment booking')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, document);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API listening on ${await app.getUrl()}`);
}

void bootstrap();