/**
 * A terv (EntitySpec) -> Matter endpoint + ketiranyu szinkron.
 *
 * Minden entitas ket dolgot tud: a Matter-parancsot a vezerlo parancsara forditja (a kezelo megvarja a HTTP-valaszt, hiba eseten
 * a Matter-parancs is hibaval ter vissza), es a poll eredmenyebol frissiti a Matter-attributumokat (update). Parancs utan az
 * entitas rovid ideig nem veszi at a poll allapotat (hold): a PCA-fade, a rele-kesleltetes es a meg uton levo regi valasz ne
 * ugraltassa az alkalmazast.
 */
import {
  MatterbridgeEndpoint, bridgedNode, powerSource, onOffPlugInUnit, onOffLight, dimmableLight, extendedColorLight, windowCovering, thermostat,
  temperatureSensor, humiditySensor, lightSensor, pressureSensor, type DeviceTypeDefinition,
} from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import {
  BridgedDeviceBasicInformation, ColorControl, IlluminanceMeasurement, LevelControl, OnOff, PressureMeasurement, RelativeHumidityMeasurement,
  TemperatureMeasurement, Thermostat, WindowCovering,
} from 'matterbridge/matter/clusters';
import { Status, StatusResponseError } from 'matterbridge/matter/types';
import { kelvinToRGB, miredToKelvin, rgbColorToXYColor, xyColorToRgbColor } from 'matterbridge/utils';
import { EntitySpec, hpaToMatter, hsToRgb, humToMatter, levelToMatter, luxToMatter, matterToLevel, normalizeRgb, rgbToHs, tempToMatter } from './entities.js';
import { Device, RgbGroup, SensorReading, Shutter, Thermostat as Zone, Usens, levelCommand, newThresholds, parseVersion, rgbLevels, switchCommand, thresholdCommand } from './myio/model.js';
import { Motion, POS_CLOSED, POS_OPEN, ShutterTracker } from './shutter.js';

/** egy poll eredmenye, elem-ID szerint indexelve */
export interface PollView {
  now: number;
  devices: Map<number, Device>;
  sensors: Map<number, SensorReading>;
  /** undefined = nem ismert (3.x firmware, vagy a fioknak nincs editor-joga az usensor.json-hoz) */
  usens?: Map<number, Usens>;
  /** a FEL kimenet ID-ja szerint */
  shutters: Map<number, Shutter>;
  thermostats: Map<number, Zone>;
  rgb: Map<number, RgbGroup>;
}

/** amit az entitas a vezerlo-kapcsolattol kap */
export interface EntityHost {
  /** endpoint-azonosito elotag (vezerlonkent egyedi) */
  readonly slug: string;
  readonly serial: string;
  readonly version: string;
  readonly vendorId: number;
  readonly debug: boolean;
  readonly log: AnsiLogger;
  /** parancs utani turelem (ms), amig a poll nem irja felul az entitast */
  readonly holdMs: number;
  /** a redony teljes futasideje (ms) */
  travelMs(name: string): number;
  /** iranyvaltas elotti szunet (ms) */
  readonly reverseDelayMs: number;
  /** parancs a vezerlonek; hibat dob, ha nem ment at */
  send(cmd: string): Promise<void>;
  /** az RGB-csoportok utolso bekapcsolt szintjei (a kikapcsolt lampa szinehez) */
  readonly rgbLast: Map<number, [number, number, number]>;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export abstract class BridgedEntity {
  readonly endpoint: MatterbridgeEndpoint;
  holdUntil = 0;

  protected constructor(public spec: EntitySpec, protected readonly host: EntityHost, types: DeviceTypeDefinition[], product: string) {
    const v = parseVersion(host.version);
    this.endpoint = new MatterbridgeEndpoint([types[0], ...types.slice(1), bridgedNode, powerSource], { id: `${host.slug}-${spec.key}` }, host.debug)
      .createDefaultBridgedDeviceBasicInformationClusterServer(spec.name, `${host.serial}-${spec.key}`.slice(-32), host.vendorId, 'myIO', product,
        (v[0] ?? 0) * 10000 + (v[1] ?? 0) * 100 + (v[2] ?? 0) || 1, host.version || '1.0.0')
      .createDefaultPowerSourceWiredClusterServer();
  }

  /** a poll eredmenyenek atvezetese a Matter-attributumokra */
  abstract update(view: PollView): Promise<void>;
  /** idozitok leallitasa (eszkoz-torles) */
  dispose(): void { /* alapbol nincs mit */ }
  /** plugin-leallas: ami felbehagyva bajt okozna, azt itt kell lezarni */
  async shutdown(): Promise<void> { this.dispose(); }
  protected fail(message: string): never { throw new StatusResponseError(`${this.spec.name}: ${message}`, Status.Failure); }

  /** az endpoint mar a Matter-node resze-e (elotte az attributum-iras hibat naplozna) */
  get active(): boolean { return String(this.endpoint.construction.status) === 'active'; }
  protected get attrLog(): AnsiLogger | undefined { return this.host.debug ? this.endpoint.log : undefined; }

  protected hold(ms = this.host.holdMs): void { this.holdUntil = Math.max(this.holdUntil, Date.now() + ms); }
  /** parancs a vezerlonek turelemmel: elotte (az uton levo regi poll-valasz ellen) es utana is.
   *  Ha nem megy at, a Matter-parancs FAILURE allapottal zarul (az alkalmazas jelzi, hogy az eszkoz nem valaszolt). */
  protected async send(cmd: string | undefined, holdMs?: number): Promise<void> {
    this.hold(holdMs);
    try {
      if (!cmd) throw new Error('no command for this element');
      await this.host.send(cmd);
    } catch (e) {
      this.holdUntil = 0;
      this.host.log.warn(`${this.spec.name}: command not sent: ${(e as Error).message}`);
      throw new StatusResponseError(`${this.spec.name}: ${(e as Error).message}`, Status.Failure);
    }
    this.hold(holdMs);
  }

  async setReachable(reachable: boolean): Promise<void> {
    if (!this.active) return;
    if (await this.endpoint.updateAttribute(BridgedDeviceBasicInformation, 'reachable', reachable, this.attrLog))
      await this.endpoint.triggerEvent(BridgedDeviceBasicInformation, 'reachableChanged', { reachableNewValue: reachable }, this.attrLog);
  }

  async rename(name: string): Promise<void> {
    this.spec = { ...this.spec, name };
    this.endpoint.deviceName = name;
    if (this.active) await this.endpoint.updateAttribute(BridgedDeviceBasicInformation, 'nodeLabel', name, this.attrLog);
  }
}

// ---- ki-be kapcsolhato kimenet: rele, kapcsolo-modu PCA, csoport ---------------------------------------------------------
class SwitchEntity extends BridgedEntity {
  constructor(spec: EntitySpec, host: EntityHost) {
    super(spec, host, [spec.kind === 'light' ? onOffLight : onOffPlugInUnit], spec.kind === 'light' ? 'myIO light' : 'myIO outlet');
    this.endpoint.createDefaultOnOffClusterServer(false).addRequiredClusterServers();
    // csak on / off kezelo kell: a toggle, az offWithEffect, az onWith... es a jelenet-visszahivas a stackben ezeken megy at
    this.endpoint
      .addCommandHandler('OnOff.on', () => this.send(switchCommand(spec.id, true)))
      .addCommandHandler('OnOff.off', () => this.send(switchCommand(spec.id, false)));
  }

  async update(view: PollView): Promise<void> {
    const d = view.devices.get(this.spec.id);
    if (d) await this.endpoint.updateAttribute(OnOff, 'onOff', d.on, this.attrLog);
  }
}

// ---- dimmer: PWM-es PCA, FET -------------------------------------------------------------------------------------------
class DimmerEntity extends BridgedEntity {
  /** a kimenet MIN / MAX szintje (a vezerlo beallitasa): a Matter-csuszka ezt a savot jarja be */
  private min = 0;
  private max = 255;

  constructor(spec: EntitySpec, host: EntityHost) {
    super(spec, host, [dimmableLight], 'myIO dimmer');
    this.endpoint.createDefaultOnOffClusterServer(false).createDefaultLevelControlClusterServer(254).addRequiredClusterServers();
    const raw = (level: number) => levelCommand(spec.id, matterToLevel(level, this.min, this.max));
    const off = () => this.send(switchCommand(spec.id, false));
    // a vezerlo ON parancsa a MAX szintre kapcsol; a Matter-lampa az utolso fenyerejere ter vissza
    const on = () => {
      const level = this.endpoint.getAttribute(LevelControl, 'currentLevel');
      return this.send(typeof level === 'number' && level > 1 ? raw(level) : switchCommand(spec.id, true));
    };
    const isOn = () => this.endpoint.getAttribute(OnOff, 'onOff') === true;
    const toLevel = (level: number, withOnOff: boolean) => {
      if (withOnOff) return level <= 1 ? off() : this.send(raw(level));
      // kikapcsolt lampan a szintvaltas csak a Matter-oldalon tarolodik (a kovetkezo ON viszi ki)
      return isOn() ? this.send(raw(level)) : Promise.resolve();
    };
    const step = (up: boolean, size: number, withOnOff: boolean) => {
      const cur = this.endpoint.getAttribute(LevelControl, 'currentLevel');
      const base = typeof cur === 'number' ? cur : 1;
      return toLevel(Math.max(1, Math.min(254, base + (up ? size : -size))), withOnOff);
    };
    this.endpoint
      .addCommandHandler('OnOff.on', on)
      .addCommandHandler('OnOff.off', off)
      .addCommandHandler('LevelControl.moveToLevel', ({ request }) => toLevel(request.level, false))
      .addCommandHandler('LevelControl.moveToLevelWithOnOff', ({ request }) => toLevel(request.level, true))
      .addCommandHandler('LevelControl.step', ({ request }) => step(request.stepMode === LevelControl.StepMode.Up, request.stepSize, false))
      .addCommandHandler('LevelControl.stepWithOnOff', ({ request }) => step(request.stepMode === LevelControl.StepMode.Up, request.stepSize, true));
  }

  async update(view: PollView): Promise<void> {
    const d = view.devices.get(this.spec.id);
    if (!d) return;
    this.min = d.min ?? 0; this.max = d.max ?? 255;
    await this.endpoint.updateAttribute(OnOff, 'onOff', d.on, this.attrLog);
    // kikapcsolva a szint a MIN: a Matter-oldalon az utolso fenyero marad
    if (d.on && d.level !== undefined) await this.endpoint.updateAttribute(LevelControl, 'currentLevel', levelToMatter(d.level, this.min, this.max), this.attrLog);
  }
}

// ---- redony: vedelem-par, futasidobol becsult pozicioval ---------------------------------------------------------------
const MOVEMENT: Record<Motion, WindowCovering.MovementStatus> = {
  opening: WindowCovering.MovementStatus.Opening, closing: WindowCovering.MovementStatus.Closing, stopped: WindowCovering.MovementStatus.Stopped,
};

class CoverEntity extends BridgedEntity {
  private tracker?: ShutterTracker;
  private stopTimer?: NodeJS.Timeout;
  private reported = '';

  constructor(spec: EntitySpec, host: EntityHost) {
    super(spec, host, [windowCovering], 'myIO shutter');
    this.endpoint
      .createDefaultWindowCoveringClusterServer(POS_OPEN, WindowCovering.WindowCoveringType.Shutter, WindowCovering.EndProductType.RollerShutter)
      .addRequiredClusterServers()
      .addCommandHandler('WindowCovering.upOrOpen', () => this.move(POS_OPEN))
      .addCommandHandler('WindowCovering.downOrClose', () => this.move(POS_CLOSED))
      .addCommandHandler('WindowCovering.stopMotion', () => this.stop(false))
      .addCommandHandler('WindowCovering.goToLiftPercentage', ({ request }) => this.move(request.liftPercent100thsValue));
  }

  private get up(): number { return this.spec.id; }
  private get down(): number { return this.spec.down!; }

  /** a becsles a Matter-oldalon megorzott pozicibol indul (ujrainditas utan is) */
  private track(now: number): ShutterTracker {
    if (!this.tracker) {
      const saved = this.endpoint.getAttribute(WindowCovering, 'currentPositionLiftPercent100ths');
      this.tracker = new ShutterTracker(typeof saved === 'number' ? saved : POS_OPEN, this.host.travelMs(this.spec.name), now);
    }
    return this.tracker;
  }

  private clearTimer(): void { if (this.stopTimer) clearTimeout(this.stopTimer); this.stopTimer = undefined; }

  private async move(target: number): Promise<void> {
    const t = this.track(Date.now());
    this.clearTimer();
    const plan = t.plan(target, Date.now());
    if (plan.dir === 'none') { if (t.motion !== 'stopped') await this.stop(false); return; }
    const opening = plan.dir === 'open';
    const stopBoth = `${switchCommand(this.up, false)}&${switchCommand(this.down, false)}`;
    if (t.motion !== 'stopped' && t.motion !== (opening ? 'opening' : 'closing')) {
      // iranyvaltas mozgas kozben: elobb allj, rovid szunet (motorvedelem), csak utana az ellenirany
      await this.send(stopBoth);
      t.stop(Date.now());
      await sleep(this.host.reverseDelayMs);
    }
    await this.send(`${switchCommand(opening ? this.down : this.up, false)}&${switchCommand(opening ? this.up : this.down, true)}`);
    t.start(plan.dir, target, Date.now());
    if (plan.runMs !== undefined) {
      this.stopTimer = setTimeout(() => { this.stop(true).catch(e => this.host.log.warn(`${this.spec.name}: timed stop failed: ${(e as Error).message}`)); }, plan.runMs);
    }
    // a Matter-parancs lezarulta utan (a cel-attributumot a stack maga irja) megy ki a mozgas-allapot
    setImmediate(() => { this.report().catch(() => undefined); });
  }

  private async stop(reached: boolean): Promise<void> {
    this.clearTimer();
    const t = this.track(Date.now());
    await this.send(`${switchCommand(this.up, false)}&${switchCommand(this.down, false)}`);
    t.stop(Date.now(), reached);
    setImmediate(() => { this.report().catch(() => undefined); });
  }

  private async report(): Promise<void> {
    if (!this.tracker || !this.active) return;
    const r = this.tracker.report();
    const sig = `${r.current}/${r.target}/${r.status}`;
    if (sig === this.reported) return;
    this.reported = sig;
    await this.endpoint.setWindowCoveringCurrentTargetStatus(r.current, r.target, MOVEMENT[r.status]);
  }

  async update(view: PollView): Promise<void> {
    const s = view.shutters.get(this.up);
    if (!s) return;
    const t = this.track(view.now);
    t.observe(s.state, view.now);
    if (t.motion === 'stopped') this.clearTimer();   // kivulrol leallitottak: az idozitett leallitas okafogyott
    await this.report();
  }

  /** a turelem alatt is megy a pozicio-becsles (a mozgas kozben a csuszka kovesse a redonyt) */
  async tick(now: number): Promise<void> {
    if (!this.tracker || this.tracker.motion === 'stopped') return;
    this.tracker.advance(now);
    await this.report();
  }

  override dispose(): void { this.clearTimer(); }

  /** koztes celra tarto redonyt nem hagyunk magara: az idozitett leallitas helyett most all meg */
  override async shutdown(): Promise<void> {
    if (this.stopTimer) await this.stop(false).catch(() => undefined);
    this.dispose();
  }
}

// ---- termosztat: homero-vezerelt rele / kapcsolo-PCA -------------------------------------------------------------------
class ThermostatEntity extends BridgedEntity {
  private zone?: Zone;
  private readonly cool: boolean;

  constructor(spec: EntitySpec, host: EntityHost, zone?: Zone) {
    super(spec, host, [thermostat], 'myIO thermostat');
    this.cool = spec.mode === 'cool';
    this.zone = zone;
    // alap-tartomany 5..35 C; a tarolo-/szolar-zonak magasabb celjahoz a hatar a jelenlegi cel fole tagul
    const target = zone?.target ?? 21;
    const min = Math.min(5, Math.floor(target) - 5), max = Math.max(35, Math.ceil(target) + 10);
    if (this.cool) this.endpoint.createDefaultCoolingThermostatClusterServer(zone?.current ?? target, target, min, max);
    else this.endpoint.createDefaultHeatingThermostatClusterServer(zone?.current ?? target, target, min, max);
    this.endpoint.addRequiredClusterServers();
    const setpoint = this.cool ? 'occupiedCoolingSetpoint' : 'occupiedHeatingSetpoint';
    this.endpoint.subscribeAttribute(Thermostat, setpoint, (value, _old, context) => {
      if (context.fabric === undefined || typeof value !== 'number') return;   // sajat (poll) iras
      this.setTarget(value / 100).catch(e => this.host.log.warn(`${this.spec.name}: setpoint not sent: ${(e as Error).message}`));
    });
    // a zonanak nincs KI-modja (a szabalyzo a vezerloben fut): a mod-valtast a kovetkezo poll visszaallitja
    this.endpoint.subscribeAttribute(Thermostat, 'systemMode', (value, _old, context) => {
      if (context.fabric !== undefined && value !== this.mode) this.host.log.notice(`${this.spec.name}: the zone has no off mode - set a low target instead (mode stays ${this.cool ? 'cool' : 'heat'})`);
    });
  }

  private get mode(): Thermostat.SystemMode { return this.cool ? Thermostat.SystemMode.Cool : Thermostat.SystemMode.Heat; }

  private async setTarget(target: number): Promise<void> {
    const z = this.zone;
    if (!z) this.fail('zone state not known yet');
    if (Math.abs(target - z.target) < 0.05) return;
    const t = newThresholds(z.on, z.off, target);
    await this.send(thresholdCommand(z.type, z.id, t.on, t.off));
    this.zone = { ...z, on: t.on, off: t.off, target };
  }

  async update(view: PollView): Promise<void> {
    const z = view.thermostats.get(this.spec.id);
    if (!z) return;
    this.zone = z;
    const ep = this.endpoint, log = this.attrLog;
    // a LocalTemperature-t a stack vezeti a kulso mert ertekbol (a kalibracios eltolassal egyutt)
    await ep.updateAttribute('thermostat', 'externalMeasuredIndoorTemperature', tempToMatter(z.current), log);
    await ep.updateAttribute(Thermostat, this.cool ? 'occupiedCoolingSetpoint' : 'occupiedHeatingSetpoint', Math.round(z.target * 100), log);
    await ep.updateAttribute(Thermostat, 'systemMode', this.mode, log);
    await ep.updateAttribute(Thermostat, 'thermostatRunningState',
      { heat: z.active && !this.cool, cool: z.active && this.cool, fan: false, heatStage2: false, coolStage2: false, fanStage2: false, fanStage3: false }, log);
  }
}

// ---- RGB: "RGB..." csoport harom dimmer-csatornaval --------------------------------------------------------------------
class RgbEntity extends BridgedEntity {
  private group?: RgbGroup;

  constructor(spec: EntitySpec, host: EntityHost) {
    super(spec, host, [extendedColorLight], 'myIO RGB light');
    this.endpoint.createDefaultOnOffClusterServer(false).createDefaultLevelControlClusterServer(254).createDefaultColorControlClusterServer().addRequiredClusterServers();
    const hue = () => Number(this.endpoint.getAttribute(ColorControl, 'currentHue') ?? 0);
    const sat = () => Number(this.endpoint.getAttribute(ColorControl, 'currentSaturation') ?? 0);
    const off = () => this.apply({ on: false });
    const on = () => this.apply({ on: true });
    const toLevel = (level: number, withOnOff: boolean) => {
      if (withOnOff) return level <= 1 ? off() : this.apply({ on: true, brightness: matterToLevel(level) });
      return this.apply({ brightness: matterToLevel(Math.max(1, level)) });
    };
    this.endpoint
      .addCommandHandler('OnOff.on', on)
      .addCommandHandler('OnOff.off', off)
      .addCommandHandler('LevelControl.moveToLevel', ({ request }) => toLevel(request.level, false))
      .addCommandHandler('LevelControl.moveToLevelWithOnOff', ({ request }) => toLevel(request.level, true))
      .addCommandHandler('ColorControl.moveToHueAndSaturation', ({ request }) => this.apply({ color: hsToRgb(request.hue, request.saturation) }))
      .addCommandHandler('ColorControl.moveToHue', ({ request }) => this.apply({ color: hsToRgb(request.hue, sat()) }))
      .addCommandHandler('ColorControl.moveToSaturation', ({ request }) => this.apply({ color: hsToRgb(hue(), request.saturation) }))
      .addCommandHandler('ColorControl.moveToColor', ({ request }) => {
        const c = xyColorToRgbColor(request.colorX / 65536, request.colorY / 65536);
        return this.apply({ color: normalizeRgb([c.r, c.g, c.b]) });
      })
      .addCommandHandler('ColorControl.moveToColorTemperature', ({ request }) => {
        const c = kelvinToRGB(miredToKelvin(request.colorTemperatureMireds));
        return this.apply({ color: normalizeRgb([c.r, c.g, c.b]) });
      });
  }

  /** a valtozas kiszamitasa a csatorna-szintekre (a fw MqttRgbCmdCalc-ja szerint) es kikuldese egy POST-ban */
  private async apply(change: { on?: boolean; color?: [number, number, number]; brightness?: number }): Promise<void> {
    const g = this.group;
    if (!g) this.fail('RGB state not known yet');
    const isOn = g.on;
    // kikapcsolt lampan a szin / fenyero csak megjegyzodik: a kovetkezo ON ezzel indul
    if (!isOn && change.on !== true) {
      if (change.on === false) return;
      const lv = rgbLevels(g, { color: change.color, brightness: change.brightness });
      if (lv !== 'off') { this.host.rgbLast.set(g.id, lv); this.group = { ...g, color: normalizeRgb(lv), brightness: Math.max(...lv) }; }
      return;
    }
    if (change.on === true && isOn && change.color === undefined && change.brightness === undefined) return;
    const lv = rgbLevels(g, change);
    const parts: string[] = [];
    for (let c = 0; c < 3; c++) {
      const ch = g.channels[c];
      if (ch) parts.push((lv === 'off' ? switchCommand(ch, false) : levelCommand(ch, lv[c]))!);
    }
    await this.send(parts.join('&'));
    if (lv !== 'off') { this.host.rgbLast.set(g.id, lv); this.group = { ...g, on: true, levels: lv, color: normalizeRgb(lv), brightness: Math.max(...lv) }; }
    else this.group = { ...g, on: false };
  }

  async update(view: PollView): Promise<void> {
    const g = view.rgb.get(this.spec.id);
    if (!g) return;
    this.group = g;
    const ep = this.endpoint, log = this.attrLog;
    await ep.updateAttribute(OnOff, 'onOff', g.on, log);
    if (!g.on) return;
    await ep.updateAttribute(LevelControl, 'currentLevel', levelToMatter(g.brightness), log);
    const hs = rgbToHs(g.color);
    const xy = rgbColorToXYColor({ r: g.color[0], g: g.color[1], b: g.color[2] });
    await ep.updateAttribute(ColorControl, 'currentHue', hs.hue, log);
    await ep.updateAttribute(ColorControl, 'currentSaturation', hs.saturation, log);
    await ep.updateAttribute(ColorControl, 'currentX', Math.max(0, Math.min(65279, Math.round(xy.x * 65536))), log);
    await ep.updateAttribute(ColorControl, 'currentY', Math.max(0, Math.min(65279, Math.round(xy.y * 65536))), log);
  }
}

// ---- szenzorok ---------------------------------------------------------------------------------------------------------
class SensorEntity extends BridgedEntity {
  constructor(spec: EntitySpec, host: EntityHost) {
    super(spec, host, [spec.kind === 'temperature' ? temperatureSensor : spec.kind === 'humidity' ? humiditySensor : spec.kind === 'illuminance' ? lightSensor : pressureSensor], 'myIO sensor');
    if (spec.kind === 'temperature') this.endpoint.createDefaultTemperatureMeasurementClusterServer(null);
    else if (spec.kind === 'humidity') this.endpoint.createDefaultRelativeHumidityMeasurementClusterServer(null);
    else if (spec.kind === 'illuminance') this.endpoint.createDefaultIlluminanceMeasurementClusterServer(null);
    else this.endpoint.createDefaultPressureMeasurementClusterServer(null);
    this.endpoint.addRequiredClusterServers();
  }

  async update(view: PollView): Promise<void> {
    let value: number | null;
    if (this.spec.source === 'usens') {
      if (!view.usens) return;
      const u = view.usens.get(this.spec.id);
      value = u && u.state === 'ok' ? u.value : null;
    } else {
      const s = view.sensors.get(this.spec.id);
      if (!s) return;
      value = s.value;
    }
    const ep = this.endpoint, log = this.attrLog;
    if (this.spec.kind === 'temperature') await ep.updateAttribute(TemperatureMeasurement, 'measuredValue', tempToMatter(value), log);
    else if (this.spec.kind === 'humidity') await ep.updateAttribute(RelativeHumidityMeasurement, 'measuredValue', humToMatter(value), log);
    else if (this.spec.kind === 'illuminance') await ep.updateAttribute(IlluminanceMeasurement, 'measuredValue', luxToMatter(value), log);
    else await ep.updateAttribute(PressureMeasurement, 'measuredValue', hpaToMatter(value), log);
  }
}

export type { CoverEntity };
export const isCover = (e: BridgedEntity): e is CoverEntity => e instanceof CoverEntity;

/** a tervbol entitas; `view` (ha van) a termosztat kezdo-hatarait adja */
export function createEntity(spec: EntitySpec, host: EntityHost, view?: PollView): BridgedEntity {
  switch (spec.kind) {
    case 'outlet': case 'light': return new SwitchEntity(spec, host);
    case 'dimmer': return new DimmerEntity(spec, host);
    case 'cover': return new CoverEntity(spec, host);
    case 'thermostat': return new ThermostatEntity(spec, host, view?.thermostats.get(spec.id));
    case 'rgb': return new RgbEntity(spec, host);
    default: return new SensorEntity(spec, host);
  }
}
