/**
 * A vezerlo elemei -> Matter-eszkoz terv (tiszta logika, Matter-fuggoseg nelkul: a tesztek kozvetlenul hivjak).
 *
 * Lekepezes (MATTER_PLAN.md 3. + a Homey / MQTT-HA entitas-modell):
 *   vedelem-par (FEL/LE)                -> redony (Window Covering)        a ket kimenet kulon NEM megy ki
 *   "RGB..." csoport R/G/B tagokkal     -> szines lampa                    a csatornak kulon NEM mennek ki
 *   homero-vezerelt rele / kapcsolo-PCA -> termosztat                      a kimenet kulon NEM megy ki
 *   rele, kapcsolo-modu PCA             -> konnektor vagy lampa (nev-kulcsszo szerint)
 *   PWM-es PCA, FET                     -> dimmelheto lampa
 *   homero / paraszenzor / usens        -> homerseklet / paratartalom / megvilagitas / legnyomas szenzor
 *   csoport (nem RGB)                   -> kapcsolo (csak keresre)
 * A keveroszelep (mixer) kimenet soha nem megy ki: azt a szabalyzo hajtja.
 */
import { Device, SensorReading, Shutter, Usens, normalizeName, thermoKind } from './myio/model.js';

export type EntityKind = 'outlet' | 'light' | 'dimmer' | 'cover' | 'thermostat' | 'rgb' | 'temperature' | 'humidity' | 'illuminance' | 'pressure';

export interface EntitySpec {
  /** vezerlon beluli stabil kulcs (a Matter endpoint tarolo-azonositoja ebbol kepzodik): r12, p2003, f101, g502, cover12, th6, rgb501, t5, h101, u7 */
  key: string;
  kind: EntityKind;
  /** megjelenitett nev (<= 32 karakter, a platformon belul egyedi) */
  name: string;
  /** fo elem-ID: kimenet / csoport / szenzor / usens azonosito; redonynel a FEL kimenet */
  id: number;
  /** redony: a LE kimenet */
  down?: number;
  /** RGB: a harom csatorna elem-ID-ja (0 = nincs) */
  channels?: [number, number, number];
  /** termosztat: futes vagy hutes (BE-kuszob < KI-kuszob = futes) */
  mode?: 'heat' | 'cool';
  /** szenzor forrasa: 1-Wire/para (sensors szekcio) vagy univerzalis szenzor */
  source?: 'sensor' | 'usens';
}

export interface PlanOptions {
  exposeUnnamed: boolean;
  relayType: 'outlet' | 'light';
  lightKeywords: string[];
  exposeShutters: boolean;
  exposeThermostats: boolean;
  exposeRgb: boolean;
  exposeSensors: boolean;
  exposeGroups: boolean;
}

export const DEFAULT_LIGHT_KEYWORDS = ['lampa', 'vilagitas', 'csillar', 'spot', 'feny', 'light', 'lamp', 'led'];
export const NAME_MAX = 32;   // Matter nodeLabel

/** a nevben (ekezet- es kisbetu-fuggetlenul) szerepel-e lampa-kulcsszo */
export function isLightName(name: string, keywords: string[]): boolean {
  const n = normalizeName(name);
  return keywords.some(k => { const q = normalizeName(k); return q.length > 0 && n.includes(q); });
}

/** usens-tipus -> szenzor-fajta (a tobbi tipusnak nincs elterjedt Matter-megfeleloje) */
export function usensKind(type: number): EntityKind | undefined {
  return type === 1 || type === 4 ? 'temperature' : type === 2 ? 'humidity' : type === 7 ? 'illuminance' : type === 8 ? 'pressure' : undefined;
}

export function planEntities(devices: Device[], sensors: SensorReading[], usens: Usens[], shutters: Shutter[], rgbGroups: { id: number; name: string; channels: [number, number, number] }[], o: PlanOptions): EntitySpec[] {
  const out: EntitySpec[] = [];
  const claimed = new Set<number>();
  const named = (name: string, fallback: string): string | undefined => (name ? name : o.exposeUnnamed ? fallback : undefined);

  if (o.exposeShutters) for (const s of shutters) {
    const name = named(s.name, `Shutter ${s.up}`);
    if (!name) continue;
    claimed.add(s.up); claimed.add(s.down);
    out.push({ key: `cover${s.up}`, kind: 'cover', name, id: s.up, down: s.down });
  }
  if (o.exposeRgb) for (const g of rgbGroups) {
    if (g.channels.some(c => c && claimed.has(c))) continue;
    for (const c of g.channels) if (c) claimed.add(c);
    claimed.add(g.id);
    out.push({ key: `rgb${g.id}`, kind: 'rgb', name: g.name, id: g.id, channels: g.channels });
  }
  for (const d of devices) {
    if (d.type === 'group' || claimed.has(d.id) || d.mixer) continue;
    const prefix = d.type === 'relay' ? 'r' : d.type === 'pca' ? 'p' : 'f';
    const fallback = `${d.type === 'relay' ? 'Relay' : d.type === 'pca' ? 'Output' : 'PWM'} ${d.id}`;
    const name = named(d.name, fallback);
    if (!name) continue;
    if (o.exposeThermostats && thermoKind(d) === 'thermostat' && d.type !== 'fet') {
      out.push({ key: `th${d.id}`, kind: 'thermostat', name, id: d.id, mode: (d.sensorON ?? 0) > (d.sensorOFF ?? 0) ? 'cool' : 'heat' });
      continue;
    }
    const dimmable = d.type === 'fet' || (d.type === 'pca' && d.pwm === true);
    const kind: EntityKind = dimmable ? 'dimmer' : o.relayType === 'light' || isLightName(name, o.lightKeywords) ? 'light' : 'outlet';
    out.push({ key: `${prefix}${d.id}`, kind, name, id: d.id });
  }
  if (o.exposeGroups) for (const g of devices) {
    if (g.type !== 'group' || claimed.has(g.id) || !g.name) continue;
    out.push({ key: `g${g.id}`, kind: isLightName(g.name, o.lightKeywords) ? 'light' : 'outlet', name: g.name, id: g.id });
  }
  if (o.exposeSensors) {
    for (const s of sensors) {
      if (s.kind === 'temperature') out.push({ key: `t${s.id}`, kind: 'temperature', name: s.name || `Temperature ${s.id}`, id: s.id, source: 'sensor' });
      // a para-helyek akkor is kijonnek a JSON-ban, ha nincs rajtuk szenzor (ertek 0): nev vagy elo ertek kell
      else if (s.kind === 'humidity' && (s.name || (s.value ?? 0) > 0)) out.push({ key: `h${s.id}`, kind: 'humidity', name: s.name || `Humidity ${s.id - 100}`, id: s.id, source: 'sensor' });
    }
    for (const u of usens) {
      const kind = usensKind(u.type);
      if (!kind || !u.enabled) continue;
      out.push({ key: `u${u.id}`, kind, name: u.name || `Sensor ${u.id}`, id: u.id, source: 'usens' });
    }
  }
  return out;
}

/** a nevek 32 karakterre vagva es a `taken` halmazon belul egyedive teve; a halmaz bovul.
 *  Utkozes a vezerlon belul -> a nev vegere az elem azonositoja kerul ("hangulat feny 2008": a myIO-feluleten latott ID),
 *  masik vezerlo elemevel -> a vezerlo neve zarojelben ("Lampa (Emelet)"), vegso esetben sorszam (" 2", " 3" ...). */
export function uniqueNames(specs: EntitySpec[], taken: Set<string>, label = ''): EntitySpec[] {
  const seen = new Set<string>();   // a vezerlon belul mar elofordult (utotag nelkuli) nevek
  const fit = (base: string, suffix: string): string => base.slice(0, NAME_MAX - suffix.length).trim() + suffix;
  const tag = label.replace(/\s+/g, ' ').trim().slice(0, 12).trim();
  return specs.map(s => {
    const base = s.name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim() || s.key;
    let name = seen.has(base.toLowerCase()) ? fit(base, ` ${s.id}`) : base;
    seen.add(base.toLowerCase());
    if (tag && taken.has(name.toLowerCase())) name = fit(name, ` (${tag})`);
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = fit(base, ` ${n}`);
    taken.add(name.toLowerCase());
    return { ...s, name };
  });
}

// ---- ertek-atvaltasok ---------------------------------------------------------------------------------------------------
/** myIO szint -> Matter CurrentLevel 1..254. A kimenet a MIN folott van bekapcsolva es a MAX-ig megy:
 *  a Matter-csuszka teljes utja a (MIN, MAX] savot jarja be, igy a 100 % mindig a beallitott MAX. */
export function levelToMatter(raw: number, min = 0, max = 255): number {
  if (max <= min + 1) return 254;
  const t = Math.max(0, Math.min(1, (raw - min - 1) / (max - min - 1)));
  return 1 + Math.round(t * 253);
}
/** Matter szint 1..254 -> myIO szint MIN+1..MAX */
export function matterToLevel(level: number, min = 0, max = 255): number {
  if (max <= min + 1) return max;
  const t = (Math.max(1, Math.min(254, level)) - 1) / 253;
  return min + 1 + Math.round(t * (max - min - 1));
}
/** C -> Matter 0,01 C (null marad null) */
export const tempToMatter = (c: number | null): number | null => (c === null ? null : Math.round(c * 100));
/** % -> Matter 0,01 % (0..10000) */
export const humToMatter = (pct: number | null): number | null => (pct === null ? null : Math.max(0, Math.min(10000, Math.round(pct * 100))));
/** lux -> Matter MeasuredValue = 10000 x log10(lux) + 1 (0 lux = 0) */
export const luxToMatter = (lux: number | null): number | null => (lux === null ? null : lux < 1 ? 0 : Math.min(0xfffe, Math.round(10000 * Math.log10(lux) + 1)));
/** hPa -> Matter 0,1 kPa (= hPa) */
export const hpaToMatter = (hpa: number | null): number | null => (hpa === null ? null : Math.round(hpa));

type Rgb = [number, number, number];
/** Matter hue/saturation (0..254) -> max-normalt RGB (a fenyero kulon megy, a LevelControl-on) */
export function hsToRgb(hue: number, sat: number): Rgb {
  const h = ((hue / 254) * 360) % 360, s = Math.max(0, Math.min(1, sat / 254));
  const c = s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = 1 - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
/** RGB -> Matter hue/saturation (0..254); a szurke/feher hue-ja 0 */
export function rgbToHs(rgb: Rgb): { hue: number; saturation: number } {
  const [r, g, b] = rgb.map(v => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: Math.round((h * 60 * 254) / 360) % 255, saturation: mx === 0 ? 0 : Math.round((d / mx) * 254) };
}
/** tetszoleges RGB -> a legnagyobb csatorna 255 (0,0,0 -> feher) */
export function normalizeRgb(rgb: Rgb): Rgb {
  const m = Math.max(...rgb);
  return m <= 0 ? [255, 255, 255] : (rgb.map(v => Math.round((Math.max(0, v) * 255) / m)) as Rgb);
}
