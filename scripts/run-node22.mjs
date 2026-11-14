// run-node22.mjs <script> [args...] - a megadott szkriptet olyan Node-dal futtatja, amelyet a Matterbridge elfogad
// (>= 22.13, 24.x vagy 26.x). Ha a PATH-on levo `node` regebbi (ezen a gepen a 20-as az alap), a Homebrew mellette
// telepitett peldanyat keresi meg. A build es az egysegtesztek barmelyik Node-dal futnak, ez csak a hidhoz kell.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const ok = v => { const [maj, min] = v.split('.').map(Number); return (maj === 22 && min >= 13) || maj === 24 || maj === 26; };
let node = process.execPath;
if (!ok(process.versions.node)) {
  const candidates = ['22', '24', '26'].flatMap(v => [`/opt/homebrew/opt/node@${v}/bin/node`, `/usr/local/opt/node@${v}/bin/node`]);
  node = candidates.find(p => fs.existsSync(p)) ?? '';
  if (!node) {
    console.error(`Matterbridge needs Node.js 22.13+, 24 or 26 - this is ${process.versions.node}, and no newer one was found.\nInstall one (e.g. brew install node@22) or run the script with it directly.`);
    process.exit(1);
  }
}
// a leallito jeleket tovabbadjuk, es megvarjuk, amig a szkript rendben kilep (a hidnak ido kell az elkoszoneshez)
const child = spawn(node, process.argv.slice(2), { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
