import { SwaggerModule } from '@nestjs/swagger';
import { createApp, openApiDocument } from './bootstrap';
import { loadConfig } from './core/config';

async function main() {
  const cfg = loadConfig();
  const app = await createApp();
  if (cfg.env !== 'production') SwaggerModule.setup('api/docs', app, openApiDocument(app));
  app.enableShutdownHooks();
  await app.listen(cfg.port, '0.0.0.0');
  console.log(JSON.stringify({ level: 'info', dienst: 'api', meldung: `API läuft auf Port ${cfg.port}`, umgebung: cfg.env, anmeldung: cfg.authMode }));
}
main().catch((e) => {
  console.error(JSON.stringify({ level: 'fatal', dienst: 'api', meldung: (e as Error).message }));
  process.exit(1);
});
