/**
 * Generates 12 realistic test users.
 *
 * There is no real "existing NestJS backend" in this repo to register/login
 * against — call-service is standalone (see main README.md) and no longer
 * verifies per-user JWTs at all: it authenticates the *calling service* via
 * a shared (apiKey, secretKey) pair (testing/lib/config.ts's
 * apiKey/secretKey) and trusts whatever userId/displayName/avatarUrl that
 * service asserts per connection (see docs/INTEGRATION.md §2.1). So there's
 * nothing per-user left to mint here — just plain identity records the rest
 * of the harness passes straight through as userId/displayName.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { faker } from '@faker-js/faker';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TestUser {
  role: string;
  name: string;
  email: string;
  password: string;
  avatarUrl: string;
  id: string; // uuid, used as the mediasoup peer identity
}

const ROLES = [
  'Host',
  'Moderator',
  'Developer 1',
  'Developer 2',
  'Developer 3',
  'Designer',
  'QA Engineer',
  'Product Manager',
  'CTO',
  'Intern',
  'HR',
  'Observer',
];

export function generateUsers(): TestUser[] {
  faker.seed(42); // deterministic across runs/CI

  return ROLES.map((role) => {
    const name = faker.person.fullName();
    const id = faker.string.uuid();
    const email = faker.internet.email({ firstName: name.split(' ')[0] });
    const avatarUrl = faker.image.avatarGitHub();
    const password = faker.internet.password({ length: 16, memorable: false });

    return { role, name, email, password, avatarUrl, id };
  });
}

function main(): void {
  const users = generateUsers();
  const outPath = path.join(__dirname, '..', 'users.json');
  fs.writeFileSync(outPath, JSON.stringify(users, null, 2));
  // eslint-disable-next-line no-console
  console.log(`Wrote ${users.length} users to ${outPath}`);
  for (const u of users) console.log(`  ${u.role.padEnd(16)} ${u.name} <${u.email}>`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
