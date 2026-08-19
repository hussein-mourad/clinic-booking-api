import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createApp } from './app.factory';

async function bootstrap() {
  const app = await createApp();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Clinic Booking API')
    .setDescription('REST API for clinic appointment booking')
    .setVersion('0.2.0')
    .addBearerAuth()
    .addTag('Auth', 'Registration and login')
    .addTag('Doctors', 'Who-is-available and doctor profile listing')
    .addTag('Doctors · Availability', 'Available appointment slots')
    .addTag('Doctors · Schedule', 'Weekly availability schedule')
    .addTag('Doctors · Blocks', 'Blocked dates and time ranges')
    .addTag('Doctors · Appointments', "Doctor's booked appointments")
    .addTag('Doctors · Analytics', 'Monthly SQL-aggregated metrics')
    .addTag('Doctors · Profile', 'Doctor profile and slot duration')
    .addTag('Appointments', 'Booking, listing and cancellation')
    .addTag('Waiting list', 'Join, leave, accept and view waiting list')
    .addTag('Health', 'Liveness/readiness checks')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, document);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API listening on ${await app.getUrl()}`);
}

void bootstrap();
