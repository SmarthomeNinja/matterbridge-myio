/**
 * A vezerlo JSON-jai -> entitasok. A myio-mcp/src/model.ts SZUKITETT MASOLATA (eszkozok, szenzorok, termosztat, redony, RGB):
 * a ket csomag kulon el (a plugin onalloan telepul), a modell valtozasat mindket helyen at kell vezetni.
 *
 * Skalak (vason igazolva, 2026-10-25): temp x100 (2556 = 25,56 C) · hum x10 · usens x10 · kuszobok (sensorON/OFF) x10 ·
 *   PCA/FET szint 0..255 NYERS (a PCA*<id>= parancs is nyers, NEM szazalek).
 * ID-terkep: rele 1..RQ · FET 101..116 · FET-fade 201+ · csoport 501.. · PCA 2001..2000+PCAQ · PCA-fade 4001+.
 * Entitas-modell: termosztat / redony / RGB = a Homey-app es az MQTT-HA ag modellje (MyIO_M7/_Mqtt.ino, mqtt_ha.cpp).
 * A sens_out.json (minimal mod) mindent hordoz, ami ide kell: state, pwm, mixer, sensor + kuszobok, csoport, vedelem-par.
 */

export interface RawOutput {
  id: number; description?: string; state?: number;
  sensor?: number; sensorON?: number; sensorOFF?: number;
  turnOFF?: number; turnON?: number; mixer?: number; pwm?: number;
  off?: number;   // [4.6] a gazda-bovito offline
}
export interface RawGroup { id: number; description?: string; state?: number; pullUP?: number; [k: string]: unknown; }
export interface RawPair { element0: number; element1: number; element0d?: string; element1d?: string; }
export interface RawSensor { id: number; description?: string; temp?: number; hum?: number; imp?: number; P?: number; U?: number; I?: number; act?: number; off?: number; }

export interface Snapshot {
  relays?: Record<string, RawOutput>;
  PCA?: Record<string, RawOutput>;
  PWM?: Record<string, RawOutput>;
  group?: Record<string, RawGroup>;
  joiner?: Record<string, RawPair>;
  protection?: Record<string, RawPair>;
  sensors?: Record<string, RawSensor>;
}

export interface InfoJson {
  info: { serial?: string; version?: string; name?: string; [k: string]: unknown };
}

/** usensor.json [4.x]: {"usensor":{"senq":N,"dpo":{...},"<id>":{en,type,val,age,state,refresh,err,description},...}} */
export interface RawUsens { en?: number; type?: number; val?: number; age?: number; state?: number; refresh?: number; err?: number; description?: string; }
export interface UsensJson { usensor?: Record<string, RawUsens | number | Record<string, unknown>>; }

export type DeviceType = 'relay' | 'pca' | 'fet' | 'group';
export interface Device {
  id: number; type: DeviceType; name: string; on: boolean;
  level?: number;        // PCA/FET 0..255
  min?: number; max?: number;   // PCA/FET MIN (turnOFF) / MAX (turnON): a MIN-en all = KI, a fenyero a MIN..MAX savban el
  pwm?: boolean;         // PCA dimmer-mod (1) / kapcsolo-mod (0)
  mixer?: boolean;
  sensor?: number; sensorON?: number; sensorOFF?: number;   // termosztat-kotes (x10 kuszobok)
  members?: number[];    // csoport tagjai (elem-ID-k)
  offline?: boolean;     // [4.6] a bovito offline
}

export type SensorKind = 'temperature' | 'humidity' | 'other';
export interface SensorReading { id: number; kind: SensorKind; name: string; value: number | null; offline?: boolean; }

export const USENS_TYPES: Record<number, { name: string; unit: string }> = {
  0: { name: 'generic', unit: '' }, 1: { name: 'temperature', unit: '°C' }, 2: { name: 'humidity', unit: '%' }, 3: { name: 'wind speed', unit: 'm/s' },
  4: { name: 'dew point', unit: '°C' }, 5: { name: 'power', unit: 'W' }, 6: { name: 'energy', unit: 'kWh' }, 7: { name: 'illuminance', unit: 'lx' },
  8: { name: 'pressure', unit: 'hPa' }, 9: { name: 'CO2', unit: 'ppm' }, 10: { name: 'voltage', unit: 'V' }, 11: { name: 'current', unit: 'A' }, 12: { name: 'battery', unit: '%' },
};
export interface Usens { id: number; name: string; type: number; value: number; state: 'ok' | 'stale' | 'none'; enabled: boolean; }

export const num = (v: unknown, def = 0): number => { const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : def; };
export const values = <T extends { id: number }>(sec?: Record<string, T>): T[] =>
  sec ? Object.values(sec).filter(x => x && typeof x === 'object').sort((a, b) => a.id - b.id) : [];

/** ekezet- es kisbetu-fuggetlen osszevetes (a fw FIND_NAME-je is igy) */
export const normalizeName = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---- ID-segedek -------------------------------------------------------------------------------------------------
export function deviceTypeOf(id: number): DeviceType | undefined {
  if (id >= 1 && id <= 100) return 'relay';
  if (id >= 101 && id <= 116) return 'fet';
  if (id >= 201 && id <= 216) return 'fet';           // fade-id -> alap
  if (id >= 501 && id <= 1999) return 'group';
  if (id >= 2001 && id <= 3024) return 'pca';
  if (id >= 4001 && id <= 5024) return 'pca';          // fade-id -> alap
  return undefined;
}
/** fade-azonosito (201+, 4001+) -> bazis-ID (a kozvetlen elemparancsok csak a bazist fogadjak, 4.17.1) */
export function baseId(id: number): number {
  if (id >= 4001 && id <= 5024) return id - 2000;
  if (id >= 201 && id <= 216) return id - 100;
  return id;
}

/** be/ki parancs egy elem-ID-re a fajtaja szerint (a fw parancs-diszpecsere) */
export function switchCommand(id: number, on: boolean): string | undefined {
  const t = deviceTypeOf(id); const b = baseId(id);
  const suffix = on ? 'ON' : 'OFF';
  if (t === 'relay') return `r_${suffix}=${b}`;
  if (t === 'pca') return `PCA_${suffix}=${b}`;
  if (t === 'fet') return `f_${suffix}=${b}`;
  if (t === 'group') return `g_${suffix}=${b}`;
  return undefined;
}
export function levelCommand(id: number, level: number): string | undefined {
  const t = deviceTypeOf(id); const b = baseId(id); const v = Math.max(0, Math.min(255, Math.round(level)));
  if (t === 'pca') return `PCA*${b}=${v}`;
  if (t === 'fet') return `fet*${b}=${v}`;
  return undefined;
}

// ---- verzio ---------------------------------------------------------------------------------------------------------
export const parseVersion = (v: string | undefined): number[] => (v ?? '').split('.').map(x => parseInt(x, 10)).map(x => (Number.isFinite(x) ? x : 0));
/** a 4.x ag (GIGA/Opta): van usensor.json; a 3.x (Due) lassabb HTTP-vel jar */
export const isV4 = (version: string | undefined): boolean => (parseVersion(version)[0] ?? 0) >= 4;

// ---- eszkozok ---------------------------------------------------------------------------------------------------------
function mergeNames<T extends { id: number; description?: string }>(live: T[], named?: Record<string, T>): T[] {
  if (!named) return live;
  const byId = new Map(values(named).map(x => [x.id, x.description ?? '']));
  return live.map(x => (x.description === undefined && byId.has(x.id) ? { ...x, description: byId.get(x.id) } : x));
}
/** a kimeneteknel a MIN/MAX szint is a nevekkel egyutt jon (a d_sens_out.json teljes mezokeszletu, a poll-vegpont nem adja) */
function mergeOutputs(live: RawOutput[], named?: Record<string, RawOutput>): RawOutput[] {
  if (!named) return live;
  const byId = new Map(values(named).map(x => [x.id, x]));
  return mergeNames(live, named).map(x => {
    const n = byId.get(x.id);
    return n && x.turnOFF === undefined && n.turnOFF !== undefined ? { ...x, turnOFF: n.turnOFF, turnON: n.turnON } : x;
  });
}

function outputToDevice(o: RawOutput, type: DeviceType): Device {
  const d: Device = { id: o.id, type, name: (o.description ?? '').trim(), on: num(o.state) > 0 };
  if (type !== 'relay') {
    d.level = num(o.state);
    // a fw szerint a PCA / FET akkor van BE, ha a szintje a MIN folott van (TurnedON)
    if (o.turnOFF !== undefined) { d.min = num(o.turnOFF); d.max = num(o.turnON, 255); d.on = d.level > d.min; }
    if (o.pwm !== undefined) d.pwm = num(o.pwm) === 1;
    if (o.mixer !== undefined) d.mixer = num(o.mixer) === 1;
  }
  if (num(o.sensor)) { d.sensor = num(o.sensor); d.sensorON = num(o.sensorON); d.sensorOFF = num(o.sensorOFF); }
  if (num(o.off)) d.offline = true;
  return d;
}

/** csoport tagjai az elementN mezokbol (a 0 = ures hely) */
export function groupMembers(g: RawGroup): number[] {
  return Object.keys(g).filter(k => /^element\d+$/.test(k)).sort((a, b) => parseInt(a.slice(7)) - parseInt(b.slice(7)))
    .map(k => num(g[k])).filter(id => id > 0);
}

/** live (sens_out.json) + nevek (d_sens_out.json) -> eszkozlista; a csoport allapota V4-ben a `state` mezo, V3-ban a tagokbol */
export function decodeDevices(live: Snapshot, names?: Snapshot): Device[] {
  const out: Device[] = [];
  for (const r of mergeNames(values(live.relays), names?.relays)) out.push(outputToDevice(r, 'relay'));
  for (const f of mergeOutputs(values(live.PWM), names?.PWM)) out.push(outputToDevice(f, 'fet'));
  for (const p of mergeOutputs(values(live.PCA), names?.PCA)) out.push(outputToDevice(p, 'pca'));
  const state = new Map(out.map(d => [d.id, d.on]));
  for (const g of mergeNames(values(live.group), names?.group)) {
    const members = groupMembers(g);
    let on: boolean;
    if (g.state !== undefined) on = num(g.state) > 0;
    else { const known = members.map(m => state.get(baseId(m))).filter(x => x !== undefined) as boolean[]; on = known.length > 0 && known.every(Boolean); }
    out.push({ id: g.id, type: 'group', name: (g.description ?? '').trim(), on, members });
  }
  return out;
}

export function decodeSensors(live: Snapshot, names?: Snapshot): SensorReading[] {
  const out: SensorReading[] = [];
  for (const s of mergeNames(values(live.sensors), names?.sensors)) {
    const base = { id: s.id, name: (s.description ?? '').trim(), offline: num(s.off) ? true : undefined } as const;
    if (s.temp !== undefined) {
      const raw = num(s.temp);
      // hibajel: -12600 (nincs szenzor) / szelsoertek -> ervenytelen
      out.push({ ...base, kind: 'temperature', value: raw <= -5500 || raw > 12500 ? null : raw / 100 });
    } else if (s.hum !== undefined) out.push({ ...base, kind: 'humidity', value: num(s.hum) / 10 });
    else out.push({ ...base, kind: 'other', value: null });
  }
  return out;
}

export function decodeUsens(json: UsensJson): Usens[] {
  const list: Usens[] = [];
  for (const [k, v] of Object.entries(json.usensor ?? {})) {
    if (!/^\d+$/.test(k) || !v || typeof v !== 'object') continue;
    const r = v as RawUsens; const st = num(r.state);
    list.push({ id: parseInt(k, 10), name: (r.description ?? '').trim(), type: num(r.type), value: num(r.val) / 10,
      state: st === 1 ? 'ok' : st === 2 ? 'stale' : 'none', enabled: num(r.en) === 1 });
  }
  return list.sort((a, b) => a.id - b.id);
}

// ---- termosztat (a Homey/MQTT modell: rele vagy nem-mixer, nem-PWM PCA, aktivator 1..100 / 301+) -------------------------
export type ThermoKind = 'thermostat' | 'humidity' | 'sun' | 'mixer' | 'dimmer';
export interface Thermostat {
  id: number; type: 'relay' | 'pca' | 'fet'; name: string; kind: ThermoKind;
  sensor: number; current: number | null;
  on: number; off: number;           // x10 nyers kuszobok (sensorON / sensorOFF)
  target: number; band: number;      // C (kozep, sav)
  mode: 'heat' | 'cool'; active: boolean;
}
export const thermoKind = (d: Device): ThermoKind | undefined =>
  !d.sensor || d.type === 'group' ? undefined
    : d.sensor === 255 ? 'sun' : d.mixer ? 'mixer' : d.sensor >= 101 && d.sensor <= 110 ? 'humidity' : d.type === 'pca' && d.pwm ? 'dimmer' : 'thermostat';
export function thermoSource(sensor: number, sensors: SensorReading[], usens: Usens[]): number | null {
  if (sensor >= 1 && sensor <= 100) return sensors.find(x => x.kind === 'temperature' && x.id === sensor)?.value ?? null;
  if (sensor >= 101 && sensor <= 110) return sensors.find(x => x.kind === 'humidity' && x.id === sensor)?.value ?? null;
  if (sensor >= 301) { const u = usens.find(x => x.id === sensor - 300); return u && u.state === 'ok' ? u.value : null; }
  return null;
}
export function decodeThermostats(devices: Device[], sensors: SensorReading[], usens: Usens[]): Thermostat[] {
  const out: Thermostat[] = [];
  for (const d of devices) {
    const kind = thermoKind(d);
    if (!kind) continue;
    const on = d.sensorON ?? 0, off = d.sensorOFF ?? 0;
    out.push({ id: d.id, type: d.type as 'relay' | 'pca' | 'fet', name: d.name, kind, sensor: d.sensor!, current: thermoSource(d.sensor!, sensors, usens),
      on, off, target: Math.round((on + off) / 2) / 10, band: Math.abs(off - on) / 10, mode: on > off ? 'cool' : 'heat', active: d.on });
  }
  return out;
}
/** uj ON/OFF kuszobok (x10) a cel valtoztatasara, a sav marad - bajtra a fw MqttThNewThresholds-ja */
export function newThresholds(on: number, off: number, target: number): { on: number; off: number } {
  const cool = on > off;
  let w = Math.abs(off - on);
  const t = Math.round(target * 10);
  if (t < -300 || t > 1000) throw new Error('target must be -30..100');
  if (w === 0) w = 10;
  const lo = Math.trunc((t * 2 - w) / 2), hi = lo + w;
  return { on: cool ? hi : lo, off: cool ? lo : hi };
}
/** a kuszob-iro parancs (rele: min_temp_ON / max_temp_OFF, PCA: PCA_temp_MIN / PCA_temp_MAX) */
export function thresholdCommand(type: 'relay' | 'pca' | 'fet', id: number, on: number, off: number): string | undefined {
  if (type === 'relay') return `min_temp_ON*${id}=${on}&max_temp_OFF*${id}=${off}`;
  if (type === 'pca') return `PCA_temp_MIN*${id}=${on}&PCA_temp_MAX*${id}=${off}`;
  return undefined;
}

// ---- redony (vedelem-par: [0] = FEL, [1] = LE) ---------------------------------------------------------------------------
export interface Shutter { index: number; name: string; up: number; down: number; state: 'opening' | 'closing' | 'stopped'; }
export function commonName(a: string, b: string): string {
  let i = 0; while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  let s = a.slice(0, i).replace(/[\s\-_./:]+$/, '');
  if (s.length < 2) s = a || b;
  return s;
}
const pairs = (sec?: Record<string, RawPair>): [number, RawPair][] =>
  sec ? Object.entries(sec).filter(([, x]) => x && typeof x === 'object').map(([k, x]) => [parseInt(k, 10), x] as [number, RawPair]).sort((a, b) => a[0] - b[0]) : [];
/** a vedelem-parok redonykent; index = a par sorszama a vezerlon (a JSON kulcsa: stabil, akkor is, ha kozben mas par torlodik) */
export function decodeShutters(snap: Snapshot, devices: Device[]): Shutter[] {
  const byId = new Map(devices.map(d => [d.id, d]));
  const out: Shutter[] = [];
  for (const [index, p] of pairs(snap.protection)) {
    if (!p.element0 || !p.element1) continue;
    const up = baseId(p.element0), down = baseId(p.element1);
    const u = byId.get(up), dn = byId.get(down);
    if (!u || !dn || u.type === 'group' || dn.type === 'group') continue;
    const upName = p.element0d || u.name, downName = p.element1d || dn.name;
    out.push({ index, name: upName && downName ? commonName(upName, downName) : upName || downName, up, down, state: u.on ? 'opening' : dn.on ? 'closing' : 'stopped' });
  }
  return out;
}

// ---- RGB (csoport "RGB..." nevvel, R/G/B kezdobetus PCA/FET tagok) -------------------------------------------------------
export interface RgbGroup { id: number; name: string; channels: [number, number, number]; levels: [number, number, number]; on: boolean; color: [number, number, number]; brightness: number; }
export function decodeRgb(devices: Device[], last: Map<number, [number, number, number]>): RgbGroup[] {
  const byId = new Map(devices.map(d => [d.id, d]));
  const out: RgbGroup[] = [];
  for (const g of devices.filter(d => d.type === 'group' && /^rgb/i.test(d.name))) {
    const ch: [number, number, number] = [0, 0, 0];
    for (const m of g.members ?? []) {
      const d = byId.get(baseId(m)); if (!d || d.level === undefined) continue;
      const c: 0 | 1 | 2 | -1 = d.name[0] === 'R' ? 0 : d.name[0] === 'G' ? 1 : d.name[0] === 'B' ? 2 : -1;
      if (c !== -1 && !ch[c]) ch[c] = d.id;
    }
    if (!ch[0] && !ch[1] && !ch[2]) continue;
    const lv: [number, number, number] = [0, 0, 0];
    let mx = 0;
    for (let c = 0; c < 3; c++) { lv[c] = ch[c] ? (byId.get(ch[c])!.level ?? 0) : 0; if (lv[c] > mx) mx = lv[c]; }
    let base = lv; let bri = mx;
    if (mx > 0) last.set(g.id, [...lv] as [number, number, number]);
    else { base = last.get(g.id) ?? [255, 255, 255]; bri = Math.max(...base); }
    const color: [number, number, number] = [0, 1, 2].map(c => (bri ? Math.round((base[c] * 255) / bri) : 255)) as [number, number, number];
    out.push({ id: g.id, name: g.name, channels: ch, levels: lv, on: mx > 0, color, brightness: bri || 255 });
  }
  return out;
}
/** az uj csatorna-szintek (a fw MqttRgbCmdCalc-ja): on/off, szin (max-normalt), fenyero */
export function rgbLevels(g: Pick<RgbGroup, 'color' | 'brightness'>, change: { on?: boolean; color?: [number, number, number]; brightness?: number }): [number, number, number] | 'off' {
  let bri = g.brightness;
  if (change.brightness !== undefined) { bri = Math.max(0, Math.min(255, Math.round(change.brightness))); if (bri === 0) return 'off'; }
  if (change.on === false) return 'off';
  const base = change.color ?? g.color;
  const m = Math.max(...base);
  if (m === 0) return 'off';
  return [0, 1, 2].map(c => Math.round((base[c] * bri) / m)) as [number, number, number];
}
