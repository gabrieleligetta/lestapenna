import { initDatabase } from '../db/schema';

// Applies the baseline schema: creates what is missing, touches nothing that exists.
console.log('Applico lo schema del database...');
initDatabase();
console.log('Schema applicato.');
