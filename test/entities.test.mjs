// A terv (melyik elem milyen Matter-eszkoz) es az ertek-atvaltasok tesztje a mock-vezerlon at (igy a REST-kliens is fut).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock_myio.mjs';
import { MyIOClient, MyIOError } from '../dist/myio/api.js';
import { decodeDevices, decodeSensors, decodeShutters, decodeRgb, decodeUsens, decodeThermostats, newThresholds, thresholdCommand, rgbLevels, switchCommand, levelCommand } from '../dist/myio/model.js';
import { planEntities, uniqueNames, isLightName, DEFAULT_LIGHT_KEYWORDS, levelToMatter, matterToLevel, tempToMatter, humToMatter, luxToMatter, hsToRgb, rgbToHs, normalizeRgb } from '../dist/entities.js';

const OPTS = { exposeUnnamed: false, relayType: 'outlet', lightKeywords: DEFAULT_LIGHT_KEYWORDS, exposeShutters: true, exposeThermostats: true, exposeRgb: true, exposeSensors: true, exposeGroups: false };
let mock, client;
before(async () => { mock = await startMock(); client = new MyIOClient({ name: 'mock', baseUrl: mock.url, minGapMs: 0 }); });
after(async () => { await mock.close(); });

async function load(opts = OPTS) {
  const names = await client.names();
  const live = await client.snapshot();
  const devices = decodeDevices(live, names);
  const sensors = decodeSensors(live, names);
  const usens = decodeUsens(await client.usensors());
  const shutters = decodeShutters(live, devices);
  const rgb = decodeRgb(devices, new Map());
  return { devices, sensors, usens, shutters, rgb, plan: planEntities(devices, sensors, usens, shutters, rgb, opts) };
}
const byKey = plan => new Map(plan.map(s => [s.key, s]));

test('the minimal poll endpoint carries everything the plan needs', async () => {
  const live = await client.snapshot();
  assert.equal(live.relays['0'].description, undefined);
  const devices = decodeDevices(live);
  assert.equal(devices.find(d => d.id === 6).sensor, 301);
  assert.equal(devices.find(d => d.id === 2018).pwm, true);
  assert.equal(decodeShutters(live, devices).length, 2);
});

test('shutters: a protection pair becomes one cover, its relays are not exposed', async () => {
  const { plan } = await load();
  const m = byKey(plan);
  assert.deepEqual(m.get('cover12'), { key: 'cover12', kind: 'cover', name: 'R. Konyha Fix', id: 12, down: 13 });
  assert.equal(m.get('cover15').name, 'R. Nappali Hátsó');
  for (const k of ['r12', 'r13', 'r15', 'r16']) assert.equal(m.has(k), false, k);
});

test('RGB group becomes one colour light, its channels are not exposed', async () => {
  const { plan } = await load();
  const m = byKey(plan);
  assert.deepEqual(m.get('rgb501').channels, [2018, 2019, 2020]);
  assert.equal(m.get('rgb501').kind, 'rgb');
  for (const k of ['p2018', 'p2019', 'p2020']) assert.equal(m.has(k), false, k);
});

test('thermostat zones replace their output; sun / dimmer zones stay plain outputs', async () => {
  const { plan } = await load();
  const m = byKey(plan);
  assert.deepEqual(m.get('th6'), { key: 'th6', kind: 'thermostat', name: 'gyerek szoba fűtés', id: 6, mode: 'heat' });
  assert.equal(m.get('th2001').kind, 'thermostat');
  assert.equal(m.has('r6'), false);
  assert.equal(m.get('r1').kind, 'light');          // "hangulat fény": napkelte/napnyugta-vezerelt, de kapcsolhato
  assert.equal(m.get('p2003').kind, 'dimmer');      // PWM-es, szenzor-vezerelt csatorna: dimmer marad
});

test('outputs: light by keyword, outlet otherwise, PWM = dimmer, unnamed hidden', async () => {
  const { plan, devices } = await load();
  const m = byKey(plan);
  assert.equal(m.get('r2').kind, 'light');           // nappali lámpa
  assert.equal(m.get('r10').kind, 'outlet');         // R. WC FEL (nincs vedelem-parban)
  assert.equal(m.get('p2006').kind, 'light');        // kerti világítás tiltás (kapcsolo-modu PCA)
  assert.equal(m.get('f110').kind, 'dimmer');        // konyha pult (FET)
  const unnamed = devices.filter(d => d.type !== 'group' && !d.name).map(d => d.id);
  assert.ok(unnamed.length > 0);
  for (const id of unnamed) assert.equal(plan.some(s => s.id === id && /^[rpf]\d/.test(s.key)), false, String(id));
  assert.equal(plan.some(s => s.key.startsWith('g')), false);
});

test('options: unnamed outputs, groups, relays as lights, sections off', async () => {
  const all = byKey((await load({ ...OPTS, exposeUnnamed: true, exposeGroups: true, relayType: 'light' })).plan);
  assert.equal(all.get('r7').name, 'Relay 7');
  assert.equal(all.get('r10').kind, 'light');
  assert.equal(all.get('g502').name, 'mennyezet csoport');
  assert.equal(all.has('g501'), false);              // az RGB-csoport lampakent mar kint van
  const none = byKey((await load({ ...OPTS, exposeShutters: false, exposeThermostats: false, exposeRgb: false, exposeSensors: false })).plan);
  assert.equal(none.get('r12').kind, 'outlet');
  assert.equal(none.get('r6').kind, 'outlet');
  assert.equal(none.get('p2018').kind, 'dimmer');
  assert.equal([...none.values()].some(s => ['cover', 'thermostat', 'rgb', 'temperature', 'humidity'].includes(s.kind)), false);
});

test('sensors: 1-Wire, named humidity slots, universal sensors by type', async () => {
  const { plan } = await load();
  const m = byKey(plan);
  assert.deepEqual(m.get('t1'), { key: 't1', kind: 'temperature', name: 'hőszenzor', id: 1, source: 'sensor' });
  assert.equal(m.get('h101').kind, 'humidity');
  assert.equal(m.has('h104'), false);                // nevtelen, ertek nelkuli para-hely
  assert.deepEqual(m.get('u1'), { key: 'u1', kind: 'temperature', name: 'Gyerekszoba hőfok', id: 1, source: 'usens' });
  assert.equal(m.get('u2').kind, 'humidity');
  assert.equal(m.has('u5'), false);                  // teljesitmeny: nincs Matter-megfeleloje ebben a korben
  assert.equal(plan.some(s => s.id === 200 || s.id === 201), false);
});

test('thermostat model: current value from the bound sensor, threshold arithmetic', async () => {
  const { devices, sensors, usens } = await load();
  const zones = decodeThermostats(devices, sensors, usens);
  const z6 = zones.find(z => z.id === 6);
  assert.deepEqual([z6.kind, z6.mode, z6.target, z6.band, z6.current], ['thermostat', 'heat', 22, 1, 21.5]);
  assert.equal(zones.find(z => z.id === 3).current, 27.12);
  assert.deepEqual(newThresholds(215, 225, 23.5), { on: 230, off: 240 });
  assert.deepEqual(newThresholds(250, 240, 26), { on: 265, off: 255 });   // hutes: BE a felso kuszob
  assert.deepEqual(newThresholds(200, 200, 21), { on: 205, off: 215 });   // nulla savbol 1 fok lesz
  assert.throws(() => newThresholds(215, 225, 150));
  assert.equal(thresholdCommand('relay', 6, 230, 240), 'min_temp_ON*6=230&max_temp_OFF*6=240');
  assert.equal(thresholdCommand('pca', 2001, 230, 240), 'PCA_temp_MIN*2001=230&PCA_temp_MAX*2001=240');
});

test('PCA / FET: on means above the MIN level, MIN / MAX come with the names', async () => {
  const names = await client.names();
  const live = await client.snapshot();
  const p = Object.values(live.PCA).find(x => x.id === 2005), n = Object.values(names.PCA).find(x => x.id === 2005);
  n.turnOFF = 30; n.turnON = 180;
  p.state = 30;
  let d = decodeDevices(live, names).find(x => x.id === 2005);
  assert.deepEqual([d.on, d.level, d.min, d.max], [false, 30, 30, 180]);
  p.state = 31;
  d = decodeDevices(live, names).find(x => x.id === 2005);
  assert.equal(d.on, true);
  assert.equal(decodeDevices(live).find(x => x.id === 2005).min, undefined);   // nevek nelkul: a 0 folotti szint = BE
});

test('commands and RGB channel levels', () => {
  assert.equal(switchCommand(12, true), 'r_ON=12');
  assert.equal(switchCommand(2003, false), 'PCA_OFF=2003');
  assert.equal(switchCommand(4018, true), 'PCA_ON=2018');
  assert.equal(switchCommand(110, true), 'f_ON=110');
  assert.equal(switchCommand(502, false), 'g_OFF=502');
  assert.equal(levelCommand(2003, 300), 'PCA*2003=255');
  assert.equal(levelCommand(110, 12.4), 'fet*110=12');
  const g = { color: [255, 128, 0], brightness: 200 };
  assert.deepEqual(rgbLevels(g, { on: true }), [200, 100, 0]);
  assert.deepEqual(rgbLevels(g, { brightness: 100 }), [100, 50, 0]);
  assert.deepEqual(rgbLevels(g, { color: [0, 0, 255] }), [0, 0, 200]);
  assert.equal(rgbLevels(g, { on: false }), 'off');
  assert.equal(rgbLevels(g, { brightness: 0 }), 'off');
});

test('names: unique within the bridge, at most 32 characters', () => {
  const spec = (key, name, id = 1) => ({ key, kind: 'outlet', name, id });
  const taken = new Set(['lámpa']);
  const out = uniqueNames([spec('r1', 'Lámpa'), spec('r2', 'lámpa'), spec('r3', '  Konyha   pult  '), spec('r4', 'x'.repeat(40)), spec('r5', 'x'.repeat(40), 5), spec('r6', '')], taken);
  assert.deepEqual(out.map(s => s.name), ['Lámpa 2', 'lámpa 1', 'Konyha pult', 'x'.repeat(32), 'x'.repeat(30) + ' 5', 'r6']);
  assert.ok(out.every(s => s.name.length <= 32));
});

test('names: a clash inside the controller gets the element id, a clash with another controller its name', () => {
  const spec = (key, name, id) => ({ key, kind: 'outlet', name, id });
  // a Dev1 esete: az 1-es rele es a 2008-as PCA neve azonos
  const dev1 = uniqueNames([spec('r1', 'hangulat fény', 1), spec('p2008', 'hangulat fény', 2008), spec('r2', 'nappali lámpa', 2)], new Set(), 'Dev1');
  assert.deepEqual(dev1.map(s => s.name), ['hangulat fény', 'hangulat fény 2008', 'nappali lámpa']);
  // masik vezerlon ugyanazok a nevek: a vezerlo neve kerul moge, a vezerlon beluli utkozesnel az ID is megmarad
  const taken = new Set(dev1.map(s => s.name.toLowerCase()));
  const up = uniqueNames([spec('r7', 'Nappali lámpa', 7), spec('r8', 'hangulat fény', 8), spec('p2001', 'hangulat fény', 2001), spec('r9', 'Kazán', 9)], taken, 'Emelet');
  assert.deepEqual(up.map(s => s.name), ['Nappali lámpa (Emelet)', 'hangulat fény (Emelet)', 'hangulat fény 2001', 'Kazán']);
  // hosszu nev + hosszu vezerlonev is belefer a 32 karakterbe, es egyedi marad
  const long = uniqueNames([spec('r1', 'x'.repeat(32), 1)], new Set(['x'.repeat(32)]), 'Földszint nagyon hosszú');
  assert.equal(long[0].name.length <= 32, true);
  assert.match(long[0].name, /^x+ \(Földszint na\)$/);
  // cimke nelkul (vagy ha a cimkes nev is foglalt) a sorszam a vegso menedek
  assert.deepEqual(uniqueNames([spec('r1', 'A', 1)], new Set(['a', 'a (emelet)']), 'Emelet').map(s => s.name), ['A 2']);
});

test('light keywords ignore case and accents', () => {
  for (const n of ['Nappali LÁMPA', 'kerti világítás', 'hangulat fény', 'Spot sor', 'LED szalag', 'Csillár']) assert.equal(isLightName(n, DEFAULT_LIGHT_KEYWORDS), true, n);
  for (const n of ['Kazán', 'Szivattyú', 'Konnektor']) assert.equal(isLightName(n, DEFAULT_LIGHT_KEYWORDS), false, n);
  assert.equal(isLightName('Kazán', ['']), false);
});

test('value scales', () => {
  assert.deepEqual([levelToMatter(0), levelToMatter(1), levelToMatter(128), levelToMatter(255)], [1, 1, 128, 254]);
  assert.deepEqual([matterToLevel(0), matterToLevel(1), matterToLevel(127), matterToLevel(254)], [1, 1, 127, 255]);
  for (const raw of [1, 37, 128, 200, 255]) assert.ok(Math.abs(matterToLevel(levelToMatter(raw)) - raw) <= 1, String(raw));
  // MIN / MAX savos kimenet (pl. 20..200): a csuszka alja a MIN folott, a teteje a MAX
  assert.deepEqual([matterToLevel(1, 20, 200), matterToLevel(254, 20, 200), matterToLevel(127, 20, 200)], [21, 200, 110]);
  assert.deepEqual([levelToMatter(21, 20, 200), levelToMatter(200, 20, 200), levelToMatter(255, 20, 200), levelToMatter(5, 20, 200)], [1, 254, 254, 1]);
  for (const raw of [21, 64, 110, 199, 200]) assert.ok(Math.abs(matterToLevel(levelToMatter(raw, 20, 200), 20, 200) - raw) <= 1, String(raw));
  assert.deepEqual([levelToMatter(7, 7, 8), matterToLevel(100, 7, 8)], [254, 8]);   // egyetlen szintu sav
  assert.deepEqual([tempToMatter(21.56), tempToMatter(-3.2), tempToMatter(null)], [2156, -320, null]);
  assert.deepEqual([humToMatter(45.3), humToMatter(120), humToMatter(null)], [4530, 10000, null]);
  assert.deepEqual([luxToMatter(0), luxToMatter(1), luxToMatter(1000), luxToMatter(null)], [0, 1, 30001, null]);
});

test('colour: Matter hue/saturation <-> RGB', () => {
  assert.deepEqual(hsToRgb(0, 254), [255, 0, 0]);
  const near = (got, want) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 4, `${got} vs ${want}`));
  near(hsToRgb(85, 254), [0, 255, 0]);                  // 85/254 = 120,5 fok
  near(hsToRgb(169, 254), [0, 0, 255]);                 // 169/254 = 239,5 fok
  near(hsToRgb(127, 127), [128, 255, 255]);             // fel telitettsegu cian
  assert.deepEqual(hsToRgb(42, 0), [255, 255, 255]);
  assert.deepEqual(rgbToHs([255, 0, 0]), { hue: 0, saturation: 254 });
  assert.deepEqual(rgbToHs([255, 255, 255]), { hue: 0, saturation: 0 });
  for (const c of [[255, 128, 0], [0, 255, 64], [32, 0, 255], [255, 0, 200]]) {
    const hs = rgbToHs(c), back = hsToRgb(hs.hue, hs.saturation);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - c[i]) <= 6, `${c} -> ${back}`);
  }
  assert.deepEqual(normalizeRgb([100, 50, 0]), [255, 128, 0]);
  assert.deepEqual(normalizeRgb([0, 0, 0]), [255, 255, 255]);
});

test('REST client: wrong password is a clear error, requests are serialised', async () => {
  const locked = await startMock({ user: 'admin', pass: 'secret' });
  try {
    const bad = new MyIOClient({ name: 'locked', baseUrl: locked.url, username: 'admin', password: 'nope', minGapMs: 0 });
    await assert.rejects(bad.info(), e => e instanceof MyIOError && e.status === 401);
    const good = new MyIOClient({ name: 'locked', baseUrl: locked.url.replace('http://', ''), username: 'admin', password: 'secret', minGapMs: 0 });
    const [info] = await Promise.all([good.info(), good.command('r_ON=40'), good.command('r_OFF=40')]);
    assert.equal(info.info.serial, 'G404-MOCK-0001');
    assert.deepEqual(locked.log, ['r_ON=40', 'r_OFF=40']);
  } finally { await locked.close(); }
  const gone = new MyIOClient({ name: 'gone', baseUrl: 'http://127.0.0.1:9', timeoutMs: 500 });
  await assert.rejects(gone.snapshot(), /cannot reach|timeout/);
});
