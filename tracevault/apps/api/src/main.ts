import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
  new Logger('Main').log(
    `TraceVault API listening on :${config.port} (${config.env}, mail=${config.mailProvider})`,
  );
}

main().catch((err) => {
  console.error(`Failed to start: ${err.message}`);
  process.exit(1);
});
