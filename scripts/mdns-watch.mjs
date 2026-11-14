// mdns-watch.mjs [IPv4-cim] [csatolo] - parositasi hibakereso: kiirja, ki keres Matter-eszkozt a halon (mDNS-kerdesek).
//   node scripts/run-node22.mjs scripts/mdns-watch.mjs 192.168.1.63 bridge1
// Ha a hub / telefon parositas kozben NEM kerdez `_matterc._udp`-t errol a halorol, akkor nem a hidban van a hiba
// (masik halon van, vagy nem a halon keres); ha kerdez, de a hidhoz nem jon kapcsolat, a valasz nem er el hozza.
// Csak hallgat, semmit nem kuld. A foglalat a csoportcimre kot (nem a kozos 5353-ra), igy a gepnek cimzett egyedi mDNS-
// csomagokat nem veszi el a rendszer Bonjour-jatol es a hidtol. Forrasonkent 10 masodpercenkent egy sor.
import dgram from 'node:dgram';

const IFACE4 = process.argv[2] ?? '0.0.0.0', IFACE6 = process.argv[3] ?? '';
const WANT = /_matterc\._udp|_matterd\._udp/;   // parosithato eszkoz / parosito keresese (az uzemi `_matter._tcp` folyamatos zaj)
const last = new Map();

function readName(buf, off) {
  const labels = [];
  let end = off, jumped = false;
  for (let guard = 0; guard < 64; guard++) {
    const len = buf[off];
    if (len === undefined) break;
    if (len === 0) { if (!jumped) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = off + 2; off = ((len & 0x3f) << 8) | buf[off + 1]; jumped = true; continue; }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
    if (!jumped) end = off;
  }
  return [labels.join('.'), end];
}

const onMessage = family => (msg, rinfo) => {
  try {
    if (msg.readUInt16BE(2) & 0x8000) return;   // valasz, nem kerdes
    const names = [];
    let off = 12;
    for (let i = msg.readUInt16BE(4); i > 0; i--) { const [name, end] = readName(msg, off); names.push(name); off = end + 4; }
    const asked = names.filter(n => WANT.test(n));
    if (!asked.length) return;
    const key = `${rinfo.address} ${asked.join(' ')}`, now = Date.now();
    if (now - (last.get(key) ?? 0) < 10000) return;
    last.set(key, now);
    console.log(`${new Date().toTimeString().slice(0, 8)} mDNS query (${family}) from ${rinfo.address}: ${asked.join(' ')}`);
  } catch { /* csonka csomag */ }
};

const v4 = dgram.createSocket({ type: 'udp4', reuseAddr: true });
v4.on('message', onMessage('IPv4')).on('error', e => console.error(`IPv4: ${e.message}`));
v4.bind({ port: 5353, address: '224.0.0.251' }, () => v4.addMembership('224.0.0.251', IFACE4 === '0.0.0.0' ? undefined : IFACE4));
if (IFACE6) {
  const v6 = dgram.createSocket({ type: 'udp6', reuseAddr: true, ipv6Only: true });
  v6.on('message', onMessage('IPv6')).on('error', e => console.error(`IPv6: ${e.message}`));
  v6.bind({ port: 5353, address: `ff02::fb%${IFACE6}` }, () => v6.addMembership('ff02::fb', `::%${IFACE6}`));
}
console.error(`listening for Matter mDNS queries on ${IFACE4}${IFACE6 ? ` + ${IFACE6}` : ''}`);
