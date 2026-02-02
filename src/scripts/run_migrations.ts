
import { initDatabase } from '../db/schema';

console.log('Running database migrations...');
initDatabase();
console.log('Migrations complete.');
