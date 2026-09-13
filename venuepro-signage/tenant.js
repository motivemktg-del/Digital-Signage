import { openStore, password } from './store.js';
import { randomUUID } from 'node:crypto';
const [name, email] = process.argv.slice(2);
if (!name || !email || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
  console.error('Usage: set ADMIN_PASSWORD (12+ characters), then node tenant.js "Tenant name" admin@example.com'); process.exit(1);
}
const db = openStore(process.env.DATA_DIR || './data');
db.exec('BEGIN IMMEDIATE');
try {
 const id = randomUUID(); db.prepare('INSERT INTO tenants VALUES (?,?)').run(id, name);
 db.prepare('INSERT INTO users (email,tenant,password) VALUES (?,?,?)').run(email.toLowerCase().trim(), id, password(process.env.ADMIN_PASSWORD));
 db.exec('COMMIT'); console.log('Tenant created:', id);
} catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.close(); }
