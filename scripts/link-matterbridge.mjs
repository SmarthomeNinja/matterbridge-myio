// link-matterbridge.mjs - a fejleszteshez a plugin node_modules/matterbridge-je a helyi (.mb) vagy a globalis
// Matterbridge-re mutat (a plugin NEM fuggosegkent hordozza: futasidoben a futo Matterbridge peldanyat kapja).
//   node scripts/link-matterbridge.mjs            -> .mb/lib/node_modules/matterbridge, ha van, kulonben `npm root -g`
//   node scripts/link-matterbridge.mjs <utvonal>  -> a megadott matterbridge-csomag
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(ROOT, '.mb', 'lib', 'node_modules', 'matterbridge');
let target = process.argv[2] ? path.resolve(process.argv[2]) : fs.existsSync(local) ? local : '';
if (!target) target = path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'matterbridge');
if (!fs.existsSync(path.join(target, 'package.json'))) {
  console.error(`matterbridge not found at ${target}\ninstall it first:  npm install -g matterbridge --prefix "${path.join(ROOT, '.mb')}"   (or globally: npm install -g matterbridge)`);
  process.exit(1);
}
const link = path.join(ROOT, 'node_modules', 'matterbridge');
fs.mkdirSync(path.dirname(link), { recursive: true });
fs.rmSync(link, { recursive: true, force: true });
fs.symlinkSync(target, link, 'dir');
console.log(`node_modules/matterbridge -> ${target} (${JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version})`);
