/**
 * Registers a new integrating service's (apiKey, secretKey) pair in the
 * DB-backed credential store (see src/credentials/credentials.service.ts).
 * The secretKey is only ever shown here, at creation — only its bcrypt
 * hash is persisted.
 *
 * Usage: npm run seed:credential -- --name <serviceName>
 */
import * as fs from 'fs';
import * as path from 'path';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import mongoose from 'mongoose';
import { ApiCredentialSchema, ApiCredentialDoc } from '../src/credentials/api-credential.schema';

function loadEnvFile(): void {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseArgs(): { name: string } {
  const nameIdx = process.argv.indexOf('--name');
  const name = nameIdx !== -1 ? process.argv[nameIdx + 1] : undefined;
  if (!name) {
    console.error('Usage: npm run seed:credential -- --name <serviceName>');
    process.exit(1);
  }
  return { name };
}

async function main(): Promise<void> {
  loadEnvFile();
  const { name } = parseArgs();

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set in .env — nothing to seed into.');
    process.exit(1);
  }

  const connection = await mongoose.createConnection(uri).asPromise();
  const model = connection.model<ApiCredentialDoc>('ApiCredential', ApiCredentialSchema);

  const apiKey = `nlx_key_${crypto.randomBytes(12).toString('hex')}`;
  const secretKey = `nlx_secret_${crypto.randomBytes(20).toString('hex')}`;
  const secretKeyHash = await bcrypt.hash(secretKey, 12);

  await model.create({ apiKey, secretKeyHash, serviceName: name, active: true });

  console.log(`Credential created for "${name}":`);
  console.log(`  apiKey:    ${apiKey}`);
  console.log(`  secretKey: ${secretKey}`);
  console.log('secretKey is shown once — store it now, only its hash is saved.');

  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
