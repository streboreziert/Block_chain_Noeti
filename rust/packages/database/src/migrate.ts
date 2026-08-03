import { createPool, migrate } from './index.js';

const pool = createPool();
await migrate(pool);
console.log('Database migrations applied.');
await pool.end();
