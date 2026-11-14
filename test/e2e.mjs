// e2e.mjs - vegponttol vegpontig: mock myIO  <-HTTP->  VALODI Matterbridge + a plugin  <-Matter->  matter.js kontroller (ez a folyamat).
// A kontroller a hidat parositja (mDNS + PASE/CASE, mint egy okoszisztema), majd Matter-parancsokkal kapcsol es az
// attributum-jelenteseket figyeli; a mock oldalon latszik, mi ment ki a vezerlonek. Hardver nem kell hozza.
//   node test/e2e.mjs           (elotte: npm run build; a Matterbridge a .mb/ alatt vagy globalisan, ld. README)
//   E2E_KEEP=1                   a munkakonyvtar (.cache/e2e) es a naplo megmarad
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Environment, ServerNode } from 'matterbridge/matter';
import { ControllerBehavior, NetworkClient } from 'matterbridge/matter/behaviors';
import { startMock } from './mock_myio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.cache', 'e2e');
const HOME = path.join(WORK, 'bridge'), CTL = path.join(WORK, 'controller'), LOG = path.join(WORK, 'bridge.log');
const MB = fs.realpathSync(path.join(ROOT, 'node_modules', 'matterbridge', 'bin', 'matterbridge.js'));
const MATTER_PORT = 5571, FRONTEND_PORT = 8491, PASSCODE = 20242025, DISCRIMINATOR = 3850;
const TRAVEL_S = 4, HOLD_MS = 2500, POLL_MS = 500, REDISCOVER_S = 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let steps = 0;
const step = async (name, fn) => { const t0 = Date.now(); try { await fn(); steps++; console.log(`  ok  ${name} (${Date.now() - t0} ms)`); } catch (e) { console.log(`  FAIL ${name}`); throw e; } };
async function until(what, fn, ms = 8000) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try { const v = fn(); if (v) return v; last = v; } catch (e) { last = e.message; }
    if (Date.now() - t0 > ms) throw new Error(`timeout after ${ms} ms: ${what} (last: ${JSON.stringify(last)})`);
    await sleep(50);
  }
}

// ---- hid-folyamat -----------------------------------------------------------------------------------------------------
let bridge;
function startBridge() {
  const out = fs.openSync(LOG, 'a');
  bridge = spawn(process.execPath, [MB, '--homedir', HOME, '--bridge', '--port', String(MATTER_PORT), '--frontend', String(FRONTEND_PORT), '--novirtual',
    '--passcode', String(PASSCODE), '--discriminator', String(DISCRIMINATOR), '--no-ansi'], { stdio: ['ignore', out, out] });
  bridge.on('exit', code => { bridge = undefined; if (code) console.log(`  (bridge exited with code ${code})`); });
  return until('bridge online', () => /Server node for Matterbridge is online/.test(fs.readFileSync(LOG, 'utf8').split('--- restart ---').pop()), 60_000);
}
async function stopBridge() {
  if (!bridge) return;
  const p = bridge;
  const gone = new Promise(r => p.once('exit', r));
  p.kill('SIGINT');
  if (!(await Promise.race([gone.then(() => true), sleep(15_000).then(() => false)]))) { p.kill('SIGKILL'); await gone; }
  fs.appendFileSync(LOG, '\n--- restart ---\n');
}
const bridgeLog = () => fs.readFileSync(LOG, 'utf8');

// ---- a mock allapota (a "vezerlo oldala") ----------------------------------------------------------------------------
let mock;
const relay = id => Object.values(mock.state.relays).find(r => r.id === id);
const pca = id => Object.values(mock.state.PCA).find(p => p.id === id);
const fet = id => Object.values(mock.state.PWM).find(p => p.id === id);
const sent = () => mock.log.splice(0);   // a legutobbi olvasas ota kapott parancsok

// ---- Matter-kontroller -------------------------------------------------------------------------------------------------
let controller, peer;
const label = ep => { try { return ep.stateOf('bridgedDeviceBasicInformation').nodeLabel; } catch { return undefined; } };
const dev = name => { for (const ep of peer.endpoints) if (label(ep) === name) return ep; throw new Error(`no Matter device named "${name}"`); };
const has = name => { for (const ep of peer.endpoints) if (label(ep) === name) return true; return false; };
const state = (name, cluster) => dev(name).stateOf(cluster);
const cmd = (name, cluster) => dev(name).commandsOf(cluster);
const types = name => state(name, 'descriptor').deviceTypeList.map(t => t.deviceType);
const OPT = { optionsMask: {}, optionsOverride: {} };

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true }); fs.mkdirSync(CTL, { recursive: true });
  mock = await startMock();
  const mockPort = mock.port;

  execFileSync(process.execPath, [MB, '--homedir', HOME, '--add', ROOT, '--no-ansi'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(HOME, '.matterbridge', 'matterbridge-myio.config.json'), JSON.stringify({
    name: 'matterbridge-myio', type: 'DynamicPlatform', controllers: [{ name: 'Mock', host: `127.0.0.1:${mockPort}` }],
    pollInterval: POLL_MS, rediscoverInterval: REDISCOVER_S, shutterTravelTime: TRAVEL_S, shutterTravelTimes: [{ name: 'R. Nappali Hátsó', seconds: 2 }],
    blackList: ['wellnes fűtés'], whiteList: [], debug: true, unregisterOnShutdown: false,
  }, null, 2));

  console.log('bridge + controller');
  await step('Matterbridge starts with the plugin', () => startBridge());
  await step('controller commissions the bridge (mDNS discovery, PASE, CASE)', async () => {
    const environment = Environment.default;
    environment.vars.set('path.root', CTL);
    environment.vars.set('log.level', 'error');
    controller = await ServerNode.create(ServerNode.RootEndpointWithoutGroupcast.with(ControllerBehavior), {
      id: 'e2e-controller', environment, commissioning: { enabled: false }, controller: { adminFabricLabel: 'myio-e2e' },
      subscriptions: { persistenceEnabled: false }, network: { autoStartCommissionedPeers: false },
      basicInformation: { nodeLabel: 'e2e', vendorId: 0xfff1, vendorName: 'test', productId: 0x8001, productName: 'e2e controller', serialNumber: 'E2E-SN', uniqueId: 'E2E-UID', hardwareVersion: 1, softwareVersion: 1 },
    });
    await controller.start();
    peer = await controller.peers.commission({ id: 'peer1', passcode: PASSCODE, discriminator: DISCRIMINATOR });
    await peer.setStateOf(NetworkClient, { autoSubscribe: true });
    await until('endpoints', () => peer.endpoints.size > 10, 15_000);
  });

  console.log('inventory');
  await step('devices: one per element, right device types, unique names', async () => {
    const labels = [...peer.endpoints].map(label).filter(Boolean);
    assert.equal(new Set(labels).size, labels.length, 'duplicate names');
    assert.equal(labels.length, 74);                                    // 75 a tervben, 1 feketelistan
    assert.equal(has('wellnes fűtés'), false);
    assert.ok(types('R. Konyha Fix').includes(0x202));                  // Window Covering
    assert.ok(types('RGB PCA 501 regulation').includes(0x10d));         // Extended Color Light
    assert.ok(types('nappali lámpa').includes(0x100));                  // On/Off Light
    assert.ok(types('R. WC FEL').includes(0x10a));                      // On/Off Plug-in Unit
    assert.ok(types('konyha pult').includes(0x101));                    // Dimmable Light
    assert.ok(types('gyerek szoba fűtés').includes(0x301));             // Thermostat
    assert.ok(types('hőszenzor').includes(0x302));                      // Temperature Sensor
    assert.ok(types('Nappali pára').includes(0x307));                   // Humidity Sensor
    assert.ok(types('nappali lámpa').includes(0x13));                   // Bridged Node
    for (const n of ['R. Konyha Fix FEL', 'R. Konyha Fix LE', 'R PCA', 'G PCA', 'B PCA']) assert.equal(has(n), false, n);
    const info = state('nappali lámpa', 'bridgedDeviceBasicInformation');
    assert.deepEqual([info.vendorName, info.serialNumber, info.softwareVersionString, info.reachable], ['myIO', 'G404-MOCK-0001-r2', '4.8.10', true]);
  });
  await step('initial state is already there (relay on, sensor values, thermostat)', async () => {
    await until('hangulat fény on', () => state('hangulat fény', 'onOff').onOff === true);   // a mintaban a rele 1 be van kapcsolva
    assert.equal(state('nappali lámpa', 'onOff').onOff, false);
    assert.equal(state('hőszenzor', 'temperatureMeasurement').measuredValue, 2712);
    await until('usens values', () => state('Gyerekszoba hőfok', 'temperatureMeasurement').measuredValue === 2150 && state('Nappali pára', 'relativeHumidityMeasurement').measuredValue === 4550);
    const th = state('gyerek szoba fűtés', 'thermostat');
    assert.deepEqual([th.localTemperature, th.occupiedHeatingSetpoint, th.systemMode], [2150, 2200, 4]);
  });
  sent();

  console.log('relay');
  await step('on / off / toggle reach the controller as explicit commands', async () => {
    await cmd('R. WC FEL', 'onOff').on();
    assert.deepEqual(sent(), ['r_ON=10']); assert.equal(relay(10).state, 1);
    await until('attr on', () => state('R. WC FEL', 'onOff').onOff === true);
    await cmd('R. WC FEL', 'onOff').toggle();
    assert.deepEqual(sent(), ['r_OFF=10']);
    await cmd('R. WC FEL', 'onOff').toggle();
    assert.deepEqual(sent(), ['r_ON=10']);
    await cmd('R. WC FEL', 'onOff').off();
    assert.deepEqual(sent(), ['r_OFF=10']); assert.equal(relay(10).state, 0);
    await until('attr off', () => state('R. WC FEL', 'onOff').onOff === false);
  });
  await step('a change on the controller side (wall button) shows up in Matter', async () => {
    await sleep(HOLD_MS);
    relay(10).state = 1;
    await until('attr follows', () => state('R. WC FEL', 'onOff').onOff === true, 4000);
    relay(10).state = 0;
    await until('attr follows', () => state('R. WC FEL', 'onOff').onOff === false, 4000);
    assert.deepEqual(sent(), []);
  });
  await step('a command the controller drops is reverted after the hold', async () => {
    const t0 = Date.now();
    await cmd('nappali lámpa', 'onOff').on();
    relay(2).state = 0;                                    // a vezerlo "nem hajtotta vegre" (pl. nincs irasjog)
    await until('on in Matter', () => state('nappali lámpa', 'onOff').onOff === true, 2000);
    await until('reverted', () => state('nappali lámpa', 'onOff').onOff === false, HOLD_MS + 3000);
    assert.ok(Date.now() - t0 >= HOLD_MS - 200, 'reverted before the hold expired');
    sent();
  });

  console.log('dimmer');
  await step('level scaled to the MIN..MAX range of the output (0..200), off, on restores the last level', async () => {
    await cmd('konyha pult', 'levelControl').moveToLevelWithOnOff({ level: 127, transitionTime: 0, ...OPT });
    assert.deepEqual(sent(), ['fet*110=100']);              // a csuszka kozepe = a 0..200 sav kozepe
    await until('attrs', () => state('konyha pult', 'onOff').onOff === true && state('konyha pult', 'levelControl').currentLevel === 127);
    await cmd('konyha pult', 'onOff').off();
    assert.deepEqual(sent(), ['f_OFF=110']);
    await cmd('konyha pult', 'onOff').on();
    assert.deepEqual(sent(), ['fet*110=100']);
    await cmd('konyha pult', 'levelControl').moveToLevel({ level: 254, transitionTime: 0, ...OPT });
    assert.deepEqual(sent(), ['fet*110=200']);              // 100 % = a beallitott MAX
    await cmd('konyha pult', 'levelControl').moveToLevelWithOnOff({ level: 1, transitionTime: 0, ...OPT });
    assert.deepEqual(sent(), ['f_OFF=110']);
  });
  await step('level set on the controller side shows up; level kept while off', async () => {
    await sleep(HOLD_MS);
    fet(110).state = 64;
    await until('level', () => state('konyha pult', 'levelControl').currentLevel === 81 && state('konyha pult', 'onOff').onOff === true, 4000);   // 64 / 200
    fet(110).state = 0;
    await until('off', () => state('konyha pult', 'onOff').onOff === false, 4000);
    assert.equal(state('konyha pult', 'levelControl').currentLevel, 81);
  });

  console.log('shutter');
  const wc = () => state('R. Konyha Fix', 'windowCovering');
  await step('close: DOWN relay on, position runs to 100 %, no timed stop', async () => {
    await cmd('R. Konyha Fix', 'windowCovering').downOrClose();
    assert.deepEqual(sent(), ['r_OFF=12', 'r_ON=13']);
    await until('closing', () => wc().operationalStatus.global === 2 && wc().targetPositionLiftPercent100ths === 10000, 3000);
    await until('half way', () => wc().currentPositionLiftPercent100ths > 3000 && wc().currentPositionLiftPercent100ths < 9000, 4000);
    await until('closed', () => wc().currentPositionLiftPercent100ths === 10000 && wc().operationalStatus.global === 0, TRAVEL_S * 1000 + 3000);
    assert.deepEqual(sent(), []);                          // a motort a vezerlo idozitoje / a vegallas allitja le
    assert.equal(relay(13).state, 1);
    relay(13).state = 0;                                   // a vezerlo idozitoje lekapcsolta
    await sleep(1500);
    assert.deepEqual([wc().currentPositionLiftPercent100ths, wc().operationalStatus.global], [10000, 0]);
  });
  await step('50 %: UP relay on, timed stop at the target', async () => {
    const t0 = Date.now();
    await cmd('R. Konyha Fix', 'windowCovering').goToLiftPercentage({ liftPercent100thsValue: 5000 });
    assert.deepEqual(sent(), ['r_OFF=13', 'r_ON=12']);
    await until('opening', () => wc().operationalStatus.global === 1, 3000);
    await until('stop sent', () => mock.log.length >= 2, TRAVEL_S * 1000);
    const took = Date.now() - t0;
    assert.deepEqual(sent(), ['r_OFF=12', 'r_OFF=13']);
    assert.ok(took > TRAVEL_S * 500 - 300 && took < TRAVEL_S * 500 + 700, `stop after ${took} ms`);
    await until('at 50 %', () => wc().currentPositionLiftPercent100ths === 5000 && wc().targetPositionLiftPercent100ths === 5000 && wc().operationalStatus.global === 0, 3000);
  });
  await step('stop while moving keeps the estimated position', async () => {
    await cmd('R. Konyha Fix', 'windowCovering').upOrOpen();
    assert.deepEqual(sent(), ['r_OFF=13', 'r_ON=12']);
    await sleep(1000);
    await cmd('R. Konyha Fix', 'windowCovering').stopMotion();
    assert.deepEqual(sent(), ['r_OFF=12', 'r_OFF=13']);
    await until('stopped', () => wc().operationalStatus.global === 0, 3000);
    const pos = wc().currentPositionLiftPercent100ths;
    assert.ok(pos > 1500 && pos < 3500, `position ${pos}`);   // 50 % - 1 s / 4 s = 25 %
    assert.equal(wc().targetPositionLiftPercent100ths, pos);
  });
  await step('reversing while moving: stop, pause, then the other direction', async () => {
    await cmd('R. Konyha Fix', 'windowCovering').downOrClose();
    assert.deepEqual(sent(), ['r_OFF=12', 'r_ON=13']);
    const t0 = Date.now();
    await cmd('R. Konyha Fix', 'windowCovering').upOrOpen();
    assert.ok(Date.now() - t0 >= 550, 'no pause before reversing');
    assert.deepEqual(sent(), ['r_OFF=12', 'r_OFF=13', 'r_OFF=13', 'r_ON=12']);
    await until('open', () => wc().currentPositionLiftPercent100ths === 0 && wc().operationalStatus.global === 0, TRAVEL_S * 1000 + 3000);
    relay(12).state = 0;
  });
  await step('moved from the wall button: followed, per-shutter travel time used', async () => {
    const w2 = () => state('R. Nappali Hátsó', 'windowCovering');
    await sleep(HOLD_MS);
    relay(16).state = 1;                                   // LE gomb a falon
    await until('closing', () => w2().operationalStatus.global === 2 && w2().targetPositionLiftPercent100ths === 10000, 3000);
    await until('closed in about 2 s', () => w2().currentPositionLiftPercent100ths === 10000, 4000);   // nev szerinti 2 s, nem a kozos 4 s
    relay(16).state = 0;
    await until('stopped', () => w2().operationalStatus.global === 0, 3000);
    assert.deepEqual(sent(), []);
  });

  console.log('thermostat');
  await step('setpoint write moves both thresholds, the band is kept', async () => {
    await dev('gyerek szoba fűtés').setStateOf('thermostat', { occupiedHeatingSetpoint: 2350 });
    await until('thresholds sent', () => mock.log.length >= 2, 4000);
    assert.deepEqual(sent(), ['min_temp_ON*6=230', 'max_temp_OFF*6=240']);
    assert.deepEqual([relay(6).sensorON, relay(6).sensorOFF], [230, 240]);
    await sleep(HOLD_MS + 1000);
    assert.equal(state('gyerek szoba fűtés', 'thermostat').occupiedHeatingSetpoint, 2350);
    assert.deepEqual(sent(), []);                          // a poll visszairasa nem kuld ujabb parancsot
  });
  await step('threshold change, heating state and temperature from the controller show up', async () => {
    relay(6).sensorON = 200; relay(6).sensorOFF = 210; relay(6).state = 1; mock.state.usens[1].val = 198;
    await until('target', () => state('gyerek szoba fűtés', 'thermostat').occupiedHeatingSetpoint === 2050, 4000);
    await until('running', () => state('gyerek szoba fűtés', 'thermostat').thermostatRunningState.heat === true, 4000);
    await until('temperature', () => state('gyerek szoba fűtés', 'thermostat').localTemperature === 1980 && state('Gyerekszoba hőfok', 'temperatureMeasurement').measuredValue === 1980, 8000);
    relay(6).state = 0;
    await until('idle', () => state('gyerek szoba fűtés', 'thermostat').thermostatRunningState.heat === false, 4000);
    assert.deepEqual(sent(), []);
  });
  await step('PCA zone uses the PCA threshold commands; off mode is put back', async () => {
    assert.equal(state('nappali fűtés', 'thermostat').occupiedHeatingSetpoint, 2250);   // 220 / 230
    await dev('nappali fűtés').setStateOf('thermostat', { occupiedHeatingSetpoint: 2100 });
    await until('thresholds sent', () => mock.log.length >= 2, 4000);
    assert.deepEqual(sent(), ['PCA_temp_MIN*2001=205', 'PCA_temp_MAX*2001=215']);
    await dev('nappali fűtés').setStateOf('thermostat', { systemMode: 0 });
    await until('mode back to heat', () => state('nappali fűtés', 'thermostat').systemMode === 4, HOLD_MS + 3000);
    assert.deepEqual(sent(), []);
  });

  console.log('RGB');
  const rgbName = 'RGB PCA 501 regulation';
  await step('on (white), colour, brightness, off, on restores colour and brightness', async () => {
    await cmd(rgbName, 'onOff').on();
    assert.deepEqual(sent(), ['PCA*2018=255', 'PCA*2019=255', 'PCA*2020=255']);
    await cmd(rgbName, 'colorControl').moveToHueAndSaturation({ hue: 0, saturation: 254, transitionTime: 0, ...OPT });
    assert.deepEqual(sent(), ['PCA*2018=255', 'PCA*2019=0', 'PCA*2020=0']);
    await cmd(rgbName, 'levelControl').moveToLevelWithOnOff({ level: 127, transitionTime: 0, ...OPT });
    assert.deepEqual(sent(), ['PCA*2018=127', 'PCA*2019=0', 'PCA*2020=0']);
    await cmd(rgbName, 'colorControl').moveToColor({ colorX: Math.round(0.1355 * 65536), colorY: Math.round(0.0399 * 65536), transitionTime: 0, ...OPT });   // kek
    const blue = sent().map(c => Number(c.split('=')[1]));
    assert.ok(blue[2] === 127 && blue[0] < 40 && blue[1] < 40, `blue ${blue}`);
    await cmd(rgbName, 'onOff').off();
    assert.deepEqual(sent(), ['PCA_OFF=2018', 'PCA_OFF=2019', 'PCA_OFF=2020']);
    await cmd(rgbName, 'colorControl').moveToHueAndSaturation({ hue: 85, saturation: 254, transitionTime: 0, ...OPT });   // kikapcsolva: csak megjegyzi
    assert.deepEqual(sent(), []);
    await cmd(rgbName, 'onOff').on();
    const green = sent().map(c => Number(c.split('=')[1]));
    assert.ok(green[1] === 127 && green[0] <= 2 && green[2] <= 2, `green ${green}`);
  });
  await step('colour set on the controller side shows up as hue / saturation / level', async () => {
    await sleep(HOLD_MS);
    pca(2018).state = 200; pca(2019).state = 0; pca(2020).state = 200;   // magenta, 200-as fenyero
    await until('magenta', () => { const c = state(rgbName, 'colorControl'); return Math.abs(c.currentHue - 212) <= 2 && c.currentSaturation === 254 && state(rgbName, 'levelControl').currentLevel === 199; }, 4000);
    pca(2018).state = 0; pca(2020).state = 0;
    await until('off', () => state(rgbName, 'onOff').onOff === false, 4000);
    assert.deepEqual(sent(), []);
  });

  console.log('rediscovery');
  await step('rename, new and removed elements follow without a restart', async () => {
    relay(10).description = 'Kerti csap';
    relay(7).description = 'Folyosó lámpa';
    relay(5).description = '';                             // lépcsőház lámpa: nev nelkul nem megy ki
    assert.equal(has('lépcsőház lámpa'), true);
    await until('renamed', () => has('Kerti csap') && !has('R. WC FEL'), REDISCOVER_S * 1000 + 6000);
    await until('added', () => has('Folyosó lámpa') && types('Folyosó lámpa').includes(0x100), 6000);
    await until('removed', () => !has('lépcsőház lámpa') && [...peer.endpoints].filter(e => label(e)).length === 74, 6000);
    await cmd('Folyosó lámpa', 'onOff').on();
    assert.deepEqual(sent(), ['r_ON=7']);
    await cmd('Kerti csap', 'onOff').on();
    assert.deepEqual(sent(), ['r_ON=10']);
  });

  console.log('controller offline / bridge restart');
  const epNumber = dev('nappali lámpa').number, coverNumber = dev('R. Konyha Fix').number;
  await step('controller unreachable: devices go unreachable, commands fail', async () => {
    await mock.close();
    await until('unreachable', () => state('nappali lámpa', 'bridgedDeviceBasicInformation').reachable === false && state('R. Konyha Fix', 'bridgedDeviceBasicInformation').reachable === false, 15_000);
    await assert.rejects(cmd('nappali lámpa', 'onOff').on());
    assert.equal(state('nappali lámpa', 'onOff').onOff, false);
  });
  await step('bridge restarted while the controller is down: devices kept (from the cache), same endpoints', async () => {
    await stopBridge();
    await startBridge();
    assert.match(bridgeLog().split('--- restart ---').pop(), /restored from the last known list/);
    await until('reconnected', () => peer.lifecycle.isOnline && has('nappali lámpa') && state('nappali lámpa', 'bridgedDeviceBasicInformation').reachable === false, 60_000);
    assert.equal([...peer.endpoints].filter(e => label(e)).length, 74);
    assert.deepEqual([dev('nappali lámpa').number, dev('R. Konyha Fix').number], [epNumber, coverNumber]);
    assert.equal(state('R. Nappali Hátsó', 'windowCovering').currentPositionLiftPercent100ths, 10000);   // a becsult pozicio megmaradt
  });
  await step('controller back: reachable again, state and commands work', async () => {
    const state0 = mock.state;
    mock = await startMock({ port: mockPort, state: state0 });
    relay(2).state = 1;
    await until('reachable', () => state('nappali lámpa', 'bridgedDeviceBasicInformation').reachable === true, 20_000);
    await until('state', () => state('nappali lámpa', 'onOff').onOff === true, 5000);
    await cmd('nappali lámpa', 'onOff').off();
    assert.deepEqual(sent(), ['r_OFF=2']);
    assert.equal(state('R. Nappali Hátsó', 'windowCovering').currentPositionLiftPercent100ths, 10000);
  });
  await step('the bridge log has no errors', async () => {
    const bad = bridgeLog().split('\n').filter(l => /\[(error|fatal)\]/.test(l));
    assert.deepEqual(bad, []);
  });
}

let failed = false;
try { await main(); console.log(`\nE2E OK - ${steps} steps`); }
catch (e) { failed = true; console.error(`\nE2E FAILED: ${e.stack ?? e}`); if (fs.existsSync(LOG)) console.error(`bridge log: ${LOG}`); }
finally {
  try { await controller?.close(); } catch { /* a kontroller leallasa nem resze a tesztnek */ }
  await stopBridge();
  try { await mock?.close(); } catch { /* mar le van allitva */ }
  if (!failed && !process.env.E2E_KEEP) fs.rmSync(WORK, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
