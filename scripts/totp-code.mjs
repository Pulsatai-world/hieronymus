// Prints a live six-digit code for each seeded local account, so local work needs no phone.
//
//   npm run code           every seeded account
//   npm run code -- rene   just the ones whose username contains "rene"

import fs from 'node:fs';
import { codeFor } from './seed-local.mjs';

const FILE = '.local-dev-accounts.json';
if (!fs.existsSync(FILE)) {
  console.log(`\nNo ${FILE} yet. Run:  npm run seed\n`);
  process.exit(1);
}
const { accounts } = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const filter = (process.argv[2] || '').toLowerCase();
const shown = accounts.filter(a => !filter || a.username.toLowerCase().includes(filter));

const secondsLeft = 30 - Math.floor((Date.now() / 1000) % 30);
console.log(`\ncodes valid for ${secondsLeft}s\n`);
for (const a of shown) {
  const label = a.kind === 'staff' ? 'staff ' : 'client';
  console.log(`  ${label}  ${a.username.padEnd(22)} ${a.password.padEnd(20)} ${codeFor(a.secret)}`);
}
console.log('');
