/**
 * myIO REST-kliens - a myio-mcp/src/api.ts SZUKITETT MASOLATA (csak ami a hidnak kell: info, allapot, nevek, usens, parancs).
 *
 * - node:http / node:https; insecureHTTPParser-rel a fw kezzel irt valaszait is elfogadja.
 * - EGY keres egyszerre vezerlonkent (a vezerlon 3 listen-socket van), Connection: close, ket keres kozt minGapMs szunet.
 * - Parancsok POST /info.json torzsben (a GET /command: ut NEM URL-dekodol); torzs <= 1024 B.
 * - A parancs valasza nem tartalmazza az uj allapotot: a kovetkezo poll olvassa vissza.
 *
 * Igazsagforras: SD_Files/js/lang/HU/API_REFERENCE.md.
 */
import http from 'node:http';
import https from 'node:https';
import type { InfoJson, Snapshot, UsensJson } from './model.js';

export interface ServerConfig {
  name: string;              // a vezerlo cimkeje
  baseUrl: string;           // http://192.168.1.178[:80] vagy csak 192.168.1.178
  username?: string;
  password?: string;
  timeoutMs?: number;        // alap 4000 (a poll es a Matter-parancs is erre var)
  minGapMs?: number;         // ket keres kozti minimalis szunet (alap 100; a Due W5500-as HTTP-je a sorozatos kereseket elutasitja)
}

export class MyIOError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); this.name = 'MyIOError'; }
}

interface HttpResult { status: number; headers: http.IncomingHttpHeaders; text: string; }

export const POST_BODY_MAX = 1024;   // a fw POST-torzs plafonja (API-ref 13.)

export class MyIOClient {
  readonly name: string;
  readonly url: URL;
  private readonly auth?: string;
  private readonly timeoutMs: number;
  minGapMs: number;
  private lastDone = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(cfg: ServerConfig) {
    this.name = cfg.name;
    this.url = new URL(cfg.baseUrl.includes('://') ? cfg.baseUrl : 'http://' + cfg.baseUrl);
    if (!this.url.pathname.endsWith('/')) this.url.pathname += '/';
    if (cfg.username) this.auth = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password ?? ''}`).toString('base64');
    this.timeoutMs = cfg.timeoutMs ?? 4000;
    this.minGapMs = cfg.minGapMs ?? 100;
  }

  /** sorba allitott keres: egyszerre egy megy ki a vezerlore. Ujraproba nincs: a GET-et a kovetkezo poll potolja,
   *  a POST-ot pedig tilos ismetelni (a hivo dont) */
  private request(method: string, path: string, body?: string): Promise<HttpResult> {
    const run = async () => {
      const wait = this.lastDone + this.minGapMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      try { return await this.rawRequest(method, path, body); } finally { this.lastDone = Date.now(); }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private rawRequest(method: string, path: string, body?: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const u = new URL(path.replace(/^\//, ''), this.url);
      const mod = u.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = { Connection: 'close', Accept: '*/*' };
      if (this.auth) headers.Authorization = this.auth;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }
      const req = mod.request({
        protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        method, path: u.pathname + u.search, headers, timeout: this.timeoutMs, insecureHTTPParser: true,
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', e => reject(new MyIOError(`${this.name}: response error: ${e.message}`)));
      });
      req.on('timeout', () => req.destroy(new MyIOError(`${this.name}: timeout after ${this.timeoutMs} ms (${method} ${u.pathname})`)));
      req.on('error', e => reject(e instanceof MyIOError ? e : new MyIOError(`${this.name}: cannot reach ${this.url.origin} (${e.message})`)));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  private check(r: HttpResult, what: string): void {
    if (r.status === 401) throw new MyIOError(`${this.name}: unauthorized (401) - check the username / password of the controller`, 401);
    if (r.status === 429) throw new MyIOError(`${this.name}: login brake (429) - too many wrong passwords from this IP; wait ${r.headers['retry-after'] ?? '?'} s`, 429);
    if (r.status === 403) throw new MyIOError(`${this.name}: forbidden (403) - this user level cannot access ${what}`, 403);
    if (r.status === 404) throw new MyIOError(`${this.name}: ${what} not found (404) - not supported by this firmware or user level`, 404);
    if (r.status !== 200) throw new MyIOError(`${this.name}: HTTP ${r.status} for ${what}`, r.status);
  }

  /** GET /<nev>.json -> JSON (a fw jog-szurt JSON-t ad: kulcs hianyozhat) */
  async getJson<T = unknown>(path: string): Promise<T> {
    const r = await this.request('GET', path);
    this.check(r, path);
    try { return JSON.parse(r.text) as T; }
    catch { throw new MyIOError(`${this.name}: ${path} is not valid JSON (${r.text.slice(0, 80).replace(/\s+/g, ' ')}...)`); }
  }

  async info(): Promise<InfoJson> {
    const info = await this.getJson<InfoJson>('info.json');
    if (!info || typeof info !== 'object' || !('info' in info)) throw new MyIOError(`${this.name}: info.json has no "info" object - not a myIO controller?`);
    return info;
  }

  /** elo allapot (minimal mezok): a poll-vegpont */
  snapshot(): Promise<Snapshot> { return this.getJson<Snapshot>('sens_out.json'); }
  /** nevek + teljes allapot (indulaskor es idonkent) */
  names(): Promise<Snapshot> { return this.getJson<Snapshot>('d_sens_out.json'); }
  /** univerzalis szenzorok [4.x] (editor-jog) */
  usensors(): Promise<UsensJson> { return this.getJson<UsensJson>('usensor.json'); }

  /** Parancs(ok) kuldese ("r_ON=16&PCA*2001=128") -> POST /info.json. Az allapotot a kovetkezo poll olvassa vissza. */
  async command(cmd: string): Promise<void> {
    if (!cmd) throw new MyIOError('empty command');
    if (Buffer.byteLength(cmd) > POST_BODY_MAX) throw new MyIOError(`command body is ${Buffer.byteLength(cmd)} B, the controller accepts at most ${POST_BODY_MAX} B per request`);
    this.check(await this.request('POST', 'info.json', cmd), 'command');
  }
}
