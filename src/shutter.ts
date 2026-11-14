/**
 * Redony-pozicio becslese futasidobol (tiszta logika). A myIO-nak nincs pozicio-modellje (FUTURE_IDEAS 13.): a redony
 * egy FEL/LE kimenet-par, a vezerlo csak azt tudja, melyik kimenet van bekapcsolva. A Matter-oldal viszont szazalekot
 * var, ezert a hid a bekapcsolt idot integralja: pos 0 = teljesen nyitva ... 10000 = teljesen zarva (Matter percent100ths).
 *
 * A becsles csuszik (indulasi holtido, terheles), de minden teljes fel/le futas a vegallason ujra szinkronba hozza.
 * A vegallasra kuldott parancs utan a hid NEM allitja le a motort (a konfiguralt futasido rovidebb lehet a valosnal):
 * azt a vezerlo idozitoje vagy a motor vegallas-kapcsoloja teszi. Idozitett leallitas csak koztes celnal van.
 */
export type Motion = 'opening' | 'closing' | 'stopped';
export const POS_OPEN = 0, POS_CLOSED = 10000;
const END_ZONE = 100;   // a vegallas 1 %-os kornyeke vegallasnak szamit

export interface MovePlan {
  /** merre kell indulni; 'none' = a koztes celon all (1 %-on belul) */
  dir: 'open' | 'close' | 'none';
  /** koztes celnal ennyi ms mulva le kell allitani; vegallasnal undefined */
  runMs?: number;
}

const clamp = (v: number): number => Math.max(POS_OPEN, Math.min(POS_CLOSED, v));
export const endTarget = (target: number): number => (target <= END_ZONE ? POS_OPEN : target >= POS_CLOSED - END_ZONE ? POS_CLOSED : Math.round(target));

export class ShutterTracker {
  /** becsult pozicio (percent100ths, tort is lehet) */
  pos: number;
  /** a kimenetek allapota: melyik irany van bekapcsolva */
  motion: Motion = 'stopped';
  /** a hid altal kiadott cel; null = nincs (all, vagy kivulrol - fali gombbal - mozgatjak) */
  target: number | null = null;
  private last: number;

  constructor(pos: number, readonly travelMs: number, now: number) {
    this.pos = clamp(pos);
    this.last = now;
  }

  /** a becsles elorevitele `now`-ig */
  advance(now: number): void {
    if (this.motion !== 'stopped' && this.travelMs > 0 && now > this.last) {
      const d = ((now - this.last) / this.travelMs) * POS_CLOSED;
      this.pos = clamp(this.pos + (this.motion === 'closing' ? d : -d));
    }
    this.last = now;
  }

  /** a vezerlo ezt az allapotot jelenti (poll) */
  observe(motion: Motion, now: number): void {
    this.advance(now);
    if (motion === this.motion) return;
    // kivulrol inditott / megforditott / leallitott mozgas: a hid celja ervenyet veszti
    if (motion === 'stopped' || (this.target !== null && motion !== (this.target > this.pos ? 'closing' : 'opening'))) this.target = null;
    this.motion = motion;
  }

  /** mit kell tenni a celhoz (a hivo kuldi a parancsot, utana start()) */
  plan(target: number, now: number): MovePlan {
    this.advance(now);
    const t = endTarget(target);
    // vegallasra MINDIG megy a parancs, akkor is, ha a becsles szerint mar ott van: ez hozza helyre az elcsuszott becslest
    if (t === POS_OPEN) return { dir: 'open' };
    if (t === POS_CLOSED) return { dir: 'close' };
    const delta = t - this.pos;
    if (Math.abs(delta) < END_ZONE) return { dir: 'none' };
    return { dir: delta > 0 ? 'close' : 'open', runMs: Math.round((Math.abs(delta) / POS_CLOSED) * this.travelMs) };
  }

  /** a hid elinditotta a mozgast a cel fele */
  start(dir: 'open' | 'close', target: number, now: number): void {
    this.advance(now);
    this.motion = dir === 'open' ? 'opening' : 'closing';
    this.target = endTarget(target);
  }

  /** a hid leallitotta a mozgast; `reached` = az idozitett leallitas a celon (a becsles pontosan a cel) */
  stop(now: number, reached = false): void {
    this.advance(now);
    if (reached && this.target !== null) this.pos = this.target;
    this.motion = 'stopped';
    this.target = null;
  }

  /** a Matter fele jelentett harmas: kerekitett pozicio, cel, mozgas (a vegallast elerve mar nem "mozog") */
  report(): { current: number; target: number; status: Motion } {
    const current = Math.round(this.pos);
    const atEnd = (this.motion === 'opening' && current <= POS_OPEN) || (this.motion === 'closing' && current >= POS_CLOSED);
    const status: Motion = atEnd ? 'stopped' : this.motion;
    const target = status === 'stopped' ? current : this.target ?? (this.motion === 'opening' ? POS_OPEN : POS_CLOSED);
    return { current, target, status };
  }
}
