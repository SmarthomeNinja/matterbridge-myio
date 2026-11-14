/**
 * matterbridge-myio - a myIO-vezerlok (GIGA/Opta 4.x, Due 3.12) Matter-hidja Matterbridge-pluginkent (MATTER_PLAN.md A. opcio).
 *
 * A vezerlon NEM kell semmit valtoztatni: a plugin ugy viselkedik, mint egy myIO Link-tars - a /sens_out.json-t pollozza,
 * a parancsokat POST /info.json-ban kuldi. Hogy mi latszik a Matter-oldalon, azt a vezerlo jogosultsagai is szabalyozzak:
 * a megadott felhasznalo altal nem lathato elem a JSON-ban sincs benne, igy ki sem ajanlodik.
 *
 * Eletciklus: onStart = felderites + az eszkozok regisztralasa (ha a vezerlo eppen nem erheto el, a legutobbi eszkozlista
 * a tarolobol jon, "nem elerheto" jelzessel - igy az okoszisztema nem torli az eszkozoket); onConfigure = poll indul.
 */
import { MatterbridgeDynamicPlatform, type PlatformConfig, type PlatformMatterbridge } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import { BridgedEntity, EntityHost, PollView, createEntity, isCover } from './devices.js';
import { DEFAULT_LIGHT_KEYWORDS, EntitySpec, PlanOptions, planEntities, uniqueNames } from './entities.js';
import { MyIOClient, MyIOError } from './myio/api.js';
import {
  Device, RgbGroup, SensorReading, Shutter, Snapshot, Usens, decodeDevices, decodeRgb, decodeSensors, decodeShutters, decodeThermostats, decodeUsens, isV4, normalizeName,
} from './myio/model.js';

export interface ControllerConfig { name?: string; host?: string; username?: string; password?: string; }
export interface ShutterTimeConfig { name?: string; seconds?: number; }
export type MyioPlatformConfig = PlatformConfig & {
  controllers?: ControllerConfig[];
  pollInterval?: number;
  rediscoverInterval?: number;
  exposeUnnamed?: boolean;
  relayType?: string;
  lightKeywords?: string[];
  exposeShutters?: boolean;
  exposeThermostats?: boolean;
  exposeRgb?: boolean;
  exposeSensors?: boolean;
  exposeGroups?: boolean;
  shutterTravelTime?: number;
  shutterTravelTimes?: ShutterTimeConfig[];
  whiteList?: string[];
  blackList?: string[];
};

const REQUIRED_MATTERBRIDGE = '3.11.0';
const USENS_MS = 5_000;              // univerzalis szenzorok ritkabban (kulon keres)
const HOLD_MS = 2_500;               // parancs utani turelem (PCA-fade, rele-kesleltetes)
const REVERSE_DELAY_MS = 600;        // redony-iranyvaltas elotti szunet
const FAILS_OFFLINE = 2;             // ennyi egymas utani sikertelen poll utan "nem elerheto"
const OFFLINE_POLL_MS = 10_000;      // nem elerheto vezerlot ritkabban probalunk
const AUTH_RETRY_MS = 60_000;        // rossz jelszonal ritkan probalunk (a vezerlo bejelentkezes-fekje IP-t zar)

interface Lists { devices: Device[]; sensors: SensorReading[]; usens?: Usens[]; shutters: Shutter[]; rgb: RgbGroup[]; }
interface CachedController { serial: string; version: string; specs: EntitySpec[]; }

const num = (v: unknown, def: number, min: number, max: number): number => { const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; };
const byId = <T extends { id: number }>(list: T[]): Map<number, T> => new Map(list.map(x => [x.id, x]));
/** a spec azon resze, amelynek valtozasa uj Matter-eszkozt kivan (a nev nem ilyen) */
const signature = (s: EntitySpec): string => [s.kind, s.id, s.down ?? '', (s.channels ?? []).join('.'), s.mode ?? '', s.source ?? ''].join('|');

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: MyioPlatformConfig): MyioPlatform {
  return new MyioPlatform(matterbridge, log, config);
}

/** egy vezerlo: kliens + az entitasai + a poll-ciklus */
class ControllerLink implements EntityHost {
  readonly client: MyIOClient;
  readonly entities = new Map<string, BridgedEntity>();
  readonly rgbLast = new Map<number, [number, number, number]>();
  readonly holdMs = HOLD_MS;
  readonly reverseDelayMs = REVERSE_DELAY_MS;
  serial = '';
  version = '';
  online = false;
  private names?: Snapshot;
  private namesAt = 0;
  private usens?: Usens[];
  private usensAt = 0;
  private usensOk = true;
  private fails = 0;
  private authFailed = false;
  private reach?: boolean;
  private running = false;
  private timer?: NodeJS.Timeout;
  private busy: Promise<void> = Promise.resolve();

  constructor(private readonly platform: MyioPlatform, readonly label: string, readonly host: string, username?: string, password?: string) {
    this.client = new MyIOClient({ name: label, baseUrl: host, username, password });
  }

  get log(): AnsiLogger { return this.platform.log; }
  get debug(): boolean { return this.platform.config.debug === true; }
  get vendorId(): number { return this.platform.matterbridge.aggregatorVendorId; }
  /** az endpoint-azonositok elotagja: a vezerlo sorozatszamabol (a konfig-beli nev es az IP valtozhat, ez nem) */
  get slug(): string { return 'myio-' + (normalizeName(this.serial).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'controller'); }
  travelMs(name: string): number { return this.platform.travelMs(name); }

  async send(cmd: string): Promise<void> {
    if (!this.online) throw new MyIOError(`${this.label}: controller is not reachable`);
    if (this.debug) this.log.info(`${this.label}: -> ${cmd}`);
    await this.client.command(cmd);
  }

  private async identify(): Promise<void> {
    const { info } = await this.client.info();
    const serial = String(info.serial ?? '') || this.host;
    if (this.serial && serial !== this.serial && this.entities.size) {
      // masik vezerlo kerult erre a cimre: a regi eszkozei nem az ovei
      this.log.notice(`${this.label}: a different controller answers at ${this.host} (${this.serial} -> ${serial}) - its device list is rebuilt`);
      await this.apply([]);
    }
    this.setIdentity(serial, String(info.version ?? ''));
  }

  private setIdentity(serial: string, version: string): void {
    this.serial = serial;
    this.version = version;
    // a Due (3.x) W5500-as HTTP-je a suru kereseket elutasitja: ott lassabb az utem
    this.client.minGapMs = isV4(version) ? 100 : 500;
  }

  private get pollMs(): number { return isV4(this.version) ? this.platform.pollMs : Math.max(this.platform.pollMs, 2000); }

  /** egy lekerdezes: `withNames` = a neveket is (ilyenkor a d_sens_out.json adja az allapotot is) */
  private async fetch(withNames: boolean): Promise<{ view: PollView; lists: Lists }> {
    const now = Date.now();
    let live: Snapshot;
    if (withNames || !this.names) { live = this.names = await this.client.names(); this.namesAt = now; }
    else live = await this.client.snapshot();
    if (isV4(this.version) && this.usensOk && (withNames || now - this.usensAt >= USENS_MS)) {
      try { this.usens = decodeUsens(await this.client.usensors()); this.usensAt = now; }
      catch (e) {
        if (!(e instanceof MyIOError) || e.status === undefined) throw e;
        this.usensOk = false; this.usens = undefined;
        this.log.info(`${this.label}: universal sensors are not available to this account (usensor.json needs editor level) - they are not exposed`);
      }
    }
    const devices = decodeDevices(live, this.names);
    const sensors = decodeSensors(live, this.names);
    const shutters = decodeShutters(live, devices);
    const rgb = decodeRgb(devices, this.rgbLast);
    const lists: Lists = { devices, sensors, usens: this.usens, shutters, rgb };
    const view: PollView = {
      now, devices: byId(devices), sensors: byId(sensors), usens: this.usens ? byId(this.usens) : undefined,
      shutters: new Map(shutters.map(s => [s.up, s])), thermostats: byId(decodeThermostats(devices, sensors, this.usens ?? [])), rgb: byId(rgb),
    };
    return { view, lists };
  }

  /** az entitasok igazitasa a tervhez: uj -> regisztral, megszunt / megvaltozott -> torol, atnevezett -> cimke-csere */
  private async sync(view: PollView, lists: Lists): Promise<void> {
    const specs = this.platform.finalize(this, planEntities(lists.devices, lists.sensors, lists.usens ?? [], lists.shutters, lists.rgb, this.platform.planOptions));
    await this.apply(specs, view);
    await this.platform.saveCache(this.host, { serial: this.serial, version: this.version, specs });
  }

  private async apply(specs: EntitySpec[], view?: PollView): Promise<void> {
    const wanted = new Map(specs.map(s => [s.key, s]));
    for (const [key, e] of this.entities) {
      const s = wanted.get(key);
      if (s && signature(s) === signature(e.spec)) continue;
      this.log.info(`${this.label}: removing ${e.spec.name} (${key})`);
      e.dispose();
      this.entities.delete(key);
      await this.platform.unregisterDevice(e.endpoint);
    }
    for (const s of specs) {
      const e = this.entities.get(s.key);
      if (e) { if (e.spec.name !== s.name) { this.log.info(`${this.label}: ${e.spec.name} renamed to ${s.name}`); await e.rename(s.name); } continue; }
      const created = createEntity(s, this, view);
      this.entities.set(s.key, created);
      await this.platform.registerDevice(created.endpoint);
    }
  }

  /** indulaskor: felderites; ha a vezerlo nem erheto el, a legutobbi eszkozlista a tarolobol */
  async discover(): Promise<void> {
    try {
      await this.identify();
      const { view, lists } = await this.fetch(true);
      await this.sync(view, lists);
      this.online = true;
      await this.push(view);
      this.log.info(`${this.label}: myIO ${this.version} (${this.serial}) at ${this.client.url.host} - ${this.entities.size} device(s) exposed`);
    } catch (e) {
      this.noteAuth(e);
      const cached = await this.platform.loadCache(this.host);
      if (cached) {
        this.setIdentity(cached.serial, cached.version);
        await this.apply(this.platform.finalize(this, cached.specs));
        this.log.warn(`${this.label}: not reachable (${(e as Error).message}) - ${this.entities.size} device(s) restored from the last known list, shown as offline`);
      } else this.log.warn(`${this.label}: not reachable (${(e as Error).message}) - its devices appear when it answers`);
    }
  }

  private noteAuth(e: unknown): void { this.authFailed = e instanceof MyIOError && (e.status === 401 || e.status === 429); }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.online ? this.pollMs : 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.busy;
    await Promise.all([...this.entities.values()].map(e => e.shutdown()));
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.busy = this.tick().catch(e => this.log.error(`${this.label}: poll crashed: ${(e as Error).stack ?? e}`)).finally(() => this.schedule(this.authFailed ? AUTH_RETRY_MS : this.online ? this.pollMs : OFFLINE_POLL_MS));
    }, ms);
  }

  private async tick(): Promise<void> {
    let view: PollView;
    try {
      const rediscover = !this.names || Date.now() - this.namesAt >= this.platform.rediscoverMs;
      if (rediscover) await this.identify();
      const got = await this.fetch(rediscover);
      view = got.view;
      if (rediscover) await this.sync(view, got.lists);
    } catch (e) {
      this.noteAuth(e);
      this.fails++;
      if (this.online && this.fails >= FAILS_OFFLINE) {
        this.log.warn(`${this.label}: not reachable: ${(e as Error).message}`);
        this.online = false;
        this.names = undefined;   // visszatereskor ujra felderitunk (kozben atnevezhettek, firmware-t cserelhettek)
      }
      if (!this.online && this.reach !== false) await this.setReachable(false);
      return;
    }
    this.fails = 0;
    this.authFailed = false;
    if (!this.online || this.reach !== true) {
      if (!this.online) this.log.notice(`${this.label}: reachable again`);
      this.online = true;
      await this.setReachable(true);
    }
    await this.push(view);
  }

  /** a poll eredmenyenek atvezetese az entitasokra (a parancs utani turelem alatt allokat kihagyva) */
  private async push(view: PollView): Promise<void> {
    for (const e of this.entities.values()) {
      if (!e.active) continue;
      try {
        if (Date.now() < e.holdUntil) { if (isCover(e)) await e.tick(Date.now()); continue; }
        await e.update(view);
      } catch (err) {
        this.log.warn(`${this.label}: ${e.spec.name}: state not updated: ${(err as Error).message}`);
      }
    }
  }

  private async setReachable(reachable: boolean): Promise<void> {
    this.reach = reachable;
    for (const e of this.entities.values()) {
      try { await e.setReachable(reachable); } catch (err) { this.log.debug(`${this.label}: ${e.spec.name}: reachable not set: ${(err as Error).message}`); }
    }
  }
}

export class MyioPlatform extends MatterbridgeDynamicPlatform {
  declare config: MyioPlatformConfig;
  private links: ControllerLink[] = [];
  pollMs = 1000;
  /** ilyen gyakran olvassa ujra a neveket es az elemkeszletet (uj / atnevezett / megszunt elem) */
  rediscoverMs = 600_000;
  planOptions: PlanOptions;
  private travelDefaultMs = 30_000;
  private travelByName = new Map<string, number>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: MyioPlatformConfig) {
    super(matterbridge, log, config);
    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion(REQUIRED_MATTERBRIDGE)) {
      throw new Error(`This plugin requires Matterbridge version >= "${REQUIRED_MATTERBRIDGE}". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`);
    }
    this.pollMs = num(config.pollInterval, 1000, 500, 60_000);
    this.rediscoverMs = num(config.rediscoverInterval, 600, 5, 86_400) * 1000;
    this.planOptions = {
      exposeUnnamed: config.exposeUnnamed === true,
      relayType: config.relayType === 'light' ? 'light' : 'outlet',
      lightKeywords: Array.isArray(config.lightKeywords) ? config.lightKeywords.filter(k => typeof k === 'string') : DEFAULT_LIGHT_KEYWORDS,
      exposeShutters: config.exposeShutters !== false,
      exposeThermostats: config.exposeThermostats !== false,
      exposeRgb: config.exposeRgb !== false,
      exposeSensors: config.exposeSensors !== false,
      exposeGroups: config.exposeGroups === true,
    };
    this.travelDefaultMs = num(config.shutterTravelTime, 30, 1, 600) * 1000;
    for (const t of Array.isArray(config.shutterTravelTimes) ? config.shutterTravelTimes : []) {
      if (t && typeof t.name === 'string' && t.name.trim()) this.travelByName.set(normalizeName(t.name), num(t.seconds, 30, 1, 600) * 1000);
    }
  }

  /** a redony teljes futasideje: nev szerinti beallitas, kulonben a kozos alapertek */
  travelMs(name: string): number { return this.travelByName.get(normalizeName(name)) ?? this.travelDefaultMs; }

  /** a terv veglegesitese: a platformon belul egyedi nevek + feher-/feketelista (a kivalaszto-listaba minden bekerul) */
  finalize(link: ControllerLink, specs: EntitySpec[]): EntitySpec[] {
    const taken = new Set<string>();
    for (const other of this.links) if (other !== link) for (const e of other.entities.values()) taken.add(e.spec.name.toLowerCase());
    return uniqueNames(specs, taken, link.label).filter(s => {
      const serial = `${link.serial}-${s.key}`.slice(-32);
      this.setSelectDevice(serial, s.name);
      return this.validateDevice([s.name, serial], false);
    });
  }

  async saveCache(host: string, data: CachedController): Promise<void> {
    try { await this.context?.set(`controller:${host}`, data); } catch (e) { this.log.debug(`cache not saved: ${(e as Error).message}`); }
  }

  async loadCache(host: string): Promise<CachedController | undefined> {
    try {
      const c = await this.context?.get<CachedController | undefined>(`controller:${host}`, undefined);
      return c && typeof c.serial === 'string' && Array.isArray(c.specs) ? c : undefined;
    } catch { return undefined; }
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`Starting platform ${this.config.name}: ${reason ?? 'no reason provided'}`);
    await this.ready;
    await this.clearSelect();
    const seen = new Set<string>();
    for (const c of Array.isArray(this.config.controllers) ? this.config.controllers : []) {
      const host = (c?.host ?? '').trim();
      if (!host || seen.has(host)) continue;
      seen.add(host);
      this.links.push(new ControllerLink(this, (c.name ?? '').trim() || host, host, c.username || undefined, c.password || undefined));
    }
    if (!this.links.length) { this.log.warn('No controller configured: open the plugin config and add the address of your myIO controller.'); return; }
    // sorban, nem parhuzamosan: az egyedi nevekhez a korabbi vezerlok eszkozei mar kellenek
    for (const link of this.links) await link.discover();
    // a poll mar itt indul (az onConfigure csak ~30 s-mal a node elindulasa utan jon): addig se alljon az allapot
    for (const link of this.links) link.start();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    for (const link of this.links) link.start();
    this.log.info(`Platform ${this.config.name} configured: ${this.links.length} controller(s), ${this.links.reduce((n, l) => n + l.entities.size, 0)} device(s)`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    await Promise.all(this.links.map(l => l.stop()));
    this.links = [];
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
    this.log.info(`Platform ${this.config.name} shut down: ${reason ?? 'no reason provided'}`);
  }
}
