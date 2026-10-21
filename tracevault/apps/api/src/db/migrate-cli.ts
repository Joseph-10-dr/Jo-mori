import { loadConfig } from '../config';
import { migrate } from './migrate';

migrate(loadConfig().databaseUrl, (m) => console.info(m))
  .then(() => console.info('migrations up to date'))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
