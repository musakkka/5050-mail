/** `node dist/migrate.js` — apply SQL migrations and exit. */
import { loadConfig } from './config.js';
import { createSql, migrate } from './db.js';

const sql = createSql(loadConfig().databaseUrl, { max: 1 });
const applied = await migrate(sql, undefined, (m) => console.log(m));
console.log(applied.length ? `applied ${applied.length} migration(s)` : 'up to date');
await sql.end();
