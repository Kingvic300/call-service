/**
 * Generates 12 realistic test users and signs a call-service JWT for each.
 *
 * There is no real "existing NestJS backend" in this repo to register/login
 * against — call-service is standalone (see main README.md) and only
 * verifies JWTs, it doesn't issue them. So instead of calling register/login
 * endpoints that don't exist here, this mints tokens locally with the same
 * JWT_SECRET/claims shape call-service expects (sub/name/avatarUrl — see
 * docs/INTEGRATION.md §2.1). Swap this for real backend calls once one
 * exists in front of call-service.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { faker } from '@faker-js/faker';
import jwt from 'jsonwebtoken';
import { config } from '../lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TestUser {
  role: string;
  name: string;
  email: string;
  password: string;
  avatarUrl: string;
  id: string; // uuid, used as the mediasoup peer identity
  token: string;
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

    const token = jwt.sign({ sub: id, name, avatarUrl }, config.jwtSecret, {
      algorithm: config.jwtAlgorithm,
      expiresIn: '6h',
    });

    return { role, name, email, password, avatarUrl, id, token };
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
