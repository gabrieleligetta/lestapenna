import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Abilita lo shutdown hooks per gestire correttamente SIGINT/SIGTERM
  app.enableShutdownHooks();
  
  await app.listen(3999);
  console.log(`Application is running on port 3999`);
}
bootstrap();
