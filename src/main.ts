import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Abilita lo shutdown hooks per gestire correttamente SIGINT/SIGTERM
  app.enableShutdownHooks();
  
  await app.listen(3000);
  console.log(`Application is running`);
}
bootstrap();
