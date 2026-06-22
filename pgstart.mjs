// Arranca un PostgreSQL embebido local (sin Docker/brew) para correr Aikestar en demo.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'fs';

const DATA_DIR = './.pgdata';
const PORT = 5433;
const USER = 'aike';
const PASSWORD = 'aike';
const DB = 'aikestar';

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
});

const firstTime = !existsSync(DATA_DIR);

if (firstTime) {
  console.log('[pg] initialising cluster...');
  await pg.initialise();
}
console.log('[pg] starting...');
await pg.start();
console.log(`[pg] running on port ${PORT}`);

if (firstTime) {
  console.log('[pg] creating database', DB);
  await pg.createDatabase(DB);
}

console.log(`[pg] DATABASE_URL=postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DB}`);
console.log('[pg] ready. Leave this process running.');

// Mantener vivo
process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
