import db from './db-instance.js';
import { initSchema } from './schema.js';

// Initialize schema on first import
initSchema();

export default db;

export * from './solar.js';
export * from './consumption.js';
export * from './schedule.js';
