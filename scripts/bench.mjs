// bench.mjs - helyi probapeldany: Matterbridge a pluginnal, sajat tarolo-konyvtarral (.bench/), a gep tobbi reszetol fuggetlenul.
//   npm run bench -- --host 192.168.1.178 --user matter --pass titok [--name Földszint]     elso inditas: a vezerlo felvetele
//   npm run bench                                                                           kesobb: csak inditas
//   tovabbi kapcsolok: --port 5540 (Matter) --frontend 8283 (webes felulet) --home <konyvtar> (alap: .bench);
//   --mdns <csatolo>: a Matter mDNS-hirdetes csak ezen a halozati csatolon menjen (pl. en0, bridge1; `all` = mind).
//     VPN-alagut / tobb csatolo mellett KELL, kulonben a telefon elerhetetlen cimet is kaphat; megjegyezzuk (.bench/bench.json)
//   --no-start: csak menti a beallitast (vezerlo, --mdns), a hidat nem inditja - ha az mar fut (pl. a szerver-kezelo alatt)
//   a Matterbridge sajat "Restart / Update Matterbridge" kapcsoloi (virtualis eszkozok) ki vannak kapcsolva (--novirtual):
//     kulonben minden okoszisztemaban megjelennenek az eszkozok kozott
//   ami a `--` utan all, a Matterbridge kapja
// A webes feluleten (http://localhost:8283) latszik a parosito QR-kod, es ott szerkesztheto a plugin beallitasa is.
// A parositas a .bench/ konyvtarban el: torlese = gyari allapot (az okoszisztemabol is torolni kell a hidat).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const link = path.join(ROOT, 'node_modules', 'matterbridge');
if (!fs.existsSync(link)) { console.error('Matterbridge is not linked: run  npm run dev:link  first (see README).'); process.exit(1); }
if (!fs.existsSync(path.join(ROOT, 'dist', 'module.js'))) { console.error('The plugin is not built: run  npm run build  first.'); process.exit(1); }
const MB = fs.realpathSync(path.join(link, 'bin', 'matterbridge.js'));

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const own = split < 0 ? argv : argv.slice(0, split), extra = split < 0 ? [] : argv.slice(split + 1);
const opt = name => { const i = own.indexOf(`--${name}`); return i >= 0 ? own[i + 1] : undefined; };
const HOME = path.resolve(opt('home') ?? path.join(ROOT, '.bench'));
const CONFIG = path.join(HOME, '.matterbridge', 'matterbridge-myio.config.json');

// a Matterbridge a pluginokat az npm globalis konyvtaraban keresi: a helyi futtatokornyezetnel az a .mb/
const env = { ...process.env };
const localPrefix = path.join(ROOT, '.mb');
if (MB.startsWith(localPrefix + path.sep)) env.npm_config_prefix = localPrefix;

fs.mkdirSync(HOME, { recursive: true });
if (!fs.existsSync(CONFIG)) {
  execFileSync(process.execPath, [MB, '--homedir', HOME, '--add', ROOT, '--no-ansi'], { stdio: 'ignore', env });
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'matterbridge-myio.config.json'), CONFIG);
}
const host = opt('host');
if (host) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const entry = { name: opt('name') ?? host, host, username: opt('user') ?? '', password: opt('pass') ?? '' };
  cfg.controllers = [...(Array.isArray(cfg.controllers) ? cfg.controllers : []).filter(c => c.host !== host), entry];
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  console.log(`controller ${entry.name} (${host}) saved to ${CONFIG}`);
}
const STATE = path.join(HOME, 'bench.json');
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
if (opt('mdns') !== undefined) {
  if (opt('mdns') === 'all') delete state.mdns; else state.mdns = opt('mdns');
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
}
const mdns = state.mdns ? ['--mdnsinterface', state.mdns] : [];
if (own.includes('--no-start')) { console.log('saved - restart the running bridge to apply'); process.exit(0); }
const controllers = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).controllers ?? [];
const frontend = opt('frontend') ?? '8283';
console.log(controllers.length
  ? `starting Matterbridge with ${controllers.length} controller(s): ${controllers.map(c => `${c.name ?? c.host} (${c.host})`).join(', ')}`
  : 'no controller configured yet: add one with  --host <ip> --user <name> --pass <password>  or in the web interface (plugin settings)');
console.log(`web interface: http://localhost:${frontend}  (pairing QR code, devices, plugin settings, logs)`);
console.log(`Matter mDNS interface: ${state.mdns ?? 'all (narrow it with  --mdns <interface>  if pairing cannot find the bridge)'}\n`);

// A Matterbridge kulon munkamenetben fut, a kimenete rajtunk megy at: igy a terminal bezarasa (SIGHUP, pl. tmux
// kill-session) nem vagja el a rendes leallast. A jelet tovabbadjuk, es megvarjuk, amig a hid leallitja a futo
// redony-mozgast es elkoszon a Matter-kontrollerektol.
const child = spawn(process.execPath, [MB, '--homedir', HOME, '--bridge', '--novirtual', '--port', opt('port') ?? '5540', '--frontend', frontend, ...mdns, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true });
for (const out of [process.stdout, process.stderr]) out.on('error', () => {});   // a terminal mar nincs meg: a naplosor elvesz, a leallas megy tovabb
child.stdout.on('data', d => process.stdout.write(d));
child.stderr.on('data', d => process.stderr.write(d));
for (const [sig, to] of [['SIGINT', 'SIGINT'], ['SIGTERM', 'SIGTERM'], ['SIGHUP', 'SIGTERM']]) process.on(sig, () => child.kill(to));
child.on('exit', code => process.exit(code ?? 0));
