import { writeFileSync } from 'node:fs';
import { createApp, openApiDocument } from './bootstrap';

/** Schreibt die OpenAPI-Spezifikation nach docs/api/openapi.json. */
async function main() {
  const app = await createApp();
  const doc = openApiDocument(app);
  writeFileSync(process.argv[2] ?? 'openapi.json', JSON.stringify(doc, null, 2));
  await app.close();
  console.log('OpenAPI geschrieben');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
