/**
 * Deterministic screen recorder for the demo video.
 *
 * - Frames come from the CDP screencast (JPEG, device-scale 2) with their compositor timestamps.
 * - Time dilation: the page runs K times slower than the final video (CSS/Web animations are slowed
 *   with Animation.setPlaybackRate, every scripted wait/move/keystroke is stretched by K), so a
 *   ~10–40 fps screencast still gives smooth motion once the compositor speeds it back up.
 * - The cursor is never captured: every move is a planned, eased trajectory that is logged and
 *   re-drawn by the compositor at 60 fps (the real mouse follows the same path for hover states).
 * - Camera moves (zoom/pan), clicks, URL changes, terminal states and clip boundaries are logged as
 *   events on the same wall clock as the frames.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession, Locator, Page } from 'playwright';

export const VW = 1440;
export const VH = 820;
export const DSF = 2;

export type Ev = { t: number; type: string; [k: string]: unknown };
type Box = { x: number; y: number; width: number; height: number };

// deterministic jitter for keystrokes
let seed = 0x5050;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

export class Recorder {
  readonly events: Ev[] = [];
  readonly frames: { t: number; file: string }[] = [];
  private cdp!: CDPSession;
  private page!: Page;
  private n = 0;
  private pending = new Set<Promise<void>>();
  pos = { x: VW / 2, y: VH / 2 };

  constructor(
    readonly dir: string,
    readonly K: number,
  ) {
    fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  }

  now() {
    return Date.now() / 1000;
  }
  log(type: string, data: Record<string, unknown> = {}) {
    this.events.push({ t: this.now(), type, ...data });
  }

  async attach(page: Page) {
    this.page = page;
    this.cdp = await page.context().newCDPSession(page);
    this.cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp: number } }) => {
      const file = `f${String(++this.n).padStart(6, '0')}.jpg`;
      this.frames.push({ t: f.metadata.timestamp, file });
      const p = fs.promises.writeFile(path.join(this.dir, 'frames', file), Buffer.from(f.data, 'base64')).then(() => void this.pending.delete(p));
      this.pending.add(p);
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    await this.cdp.send('Animation.enable');
    await this.slowAnimations();
    page.on('load', () => void this.slowAnimations().catch(() => undefined));
    page.on('framenavigated', (fr) => {
      if (fr === page.mainFrame()) this.log('url', { url: fr.url() });
    });
  }

  private async slowAnimations() {
    await this.cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / this.K });
  }

  async startCapture() {
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VW * DSF, maxHeight: VH * DSF, everyNthFrame: 1 });
    this.log('url', { url: this.page.url() });
  }
  async stopCapture() {
    await this.cdp.send('Page.stopScreencast');
    await Promise.all([...this.pending]);
  }

  /** Waits `s` seconds of *video* time. */
  wait(s: number) {
    return this.page.waitForTimeout(s * this.K * 1000);
  }

  clip(name: string, opts: Record<string, unknown> = {}) {
    this.log('clip', { name, ...opts, cursor: { ...this.pos } });
  }
  endClip() {
    this.log('clipEnd');
  }
  /** Camera: zoom around a point (CSS px of the page). zoom 1 = whole window. */
  cam(zoom: number, at?: { x: number; y: number } | Box, dur = 0.9) {
    const c = at ? ('width' in at ? { x: at.x + at.width / 2, y: at.y + at.height / 2 } : at) : { x: VW / 2, y: VH / 2 };
    this.log('cam', { zoom, x: c.x, y: c.y, dur });
  }
  cursorVisible(v: boolean) {
    this.log('cursor', { visible: v });
  }

  /** Glide the pointer to (x, y) along an eased, slightly curved path. */
  async moveTo(x: number, y: number, dur?: number) {
    const from = { ...this.pos };
    const dist = Math.hypot(x - from.x, y - from.y);
    if (dist < 1) return;
    const d = dur ?? Math.min(0.7, Math.max(0.28, 0.22 + dist / 1800));
    // a gentle arc: control point offset perpendicular to the path
    const bend = Math.min(60, dist * 0.08) * (from.x < x ? -1 : 1);
    const nx = -(y - from.y) / dist;
    const ny = (x - from.x) / dist;
    const ctrl = { x: (from.x + x) / 2 + nx * bend, y: (from.y + y) / 2 + ny * bend };
    const t0 = this.now();
    const t1 = t0 + d * this.K;
    this.log('move', { t0, t1, from, ctrl, to: { x, y } });
    for (;;) {
      const now = this.now();
      const p = Math.min(1, (now - t0) / (t1 - t0));
      const e = easeInOut(p);
      const px = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * ctrl.x + e * e * x;
      const py = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * ctrl.y + e * e * y;
      await this.page.mouse.move(px, py);
      if (p >= 1) break;
      await this.page.waitForTimeout(16);
    }
    this.pos = { x, y };
  }

  async box(target: Locator): Promise<Box> {
    await target.waitFor({ state: 'visible' });
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    if (!b) throw new Error(`no box for ${target}`);
    return b;
  }

  async hover(target: Locator, at: { dx?: number; dy?: number; fx?: number; fy?: number } = {}) {
    const b = await this.box(target);
    await this.moveTo(b.x + b.width * (at.fx ?? 0.5) + (at.dx ?? 0), b.y + b.height * (at.fy ?? 0.5) + (at.dy ?? 0));
    return b;
  }

  async click(target: Locator, at: { dx?: number; dy?: number; fx?: number; fy?: number } = {}) {
    const b = await this.hover(target, at);
    await this.wait(0.08);
    this.log('click', { ...this.pos });
    await this.page.mouse.down();
    await this.wait(0.07);
    await this.page.mouse.up();
    return b;
  }

  /** Keystroke schedule (video seconds from start) for `text` at `cps` characters per second, with jitter and pauses. */
  static schedule(text: string, cps: number, pauses = true): number[] {
    const out: number[] = [];
    let acc = 0;
    const chars = [...text];
    for (const [i, ch] of chars.entries()) {
      let d = (1 / cps) * (0.6 + rnd() * 0.8);
      // a beat after the end of a clause, not inside addresses or URLs
      if (pauses && /[,.!?]/.test(ch) && /^[\s]?$/.test(chars[i + 1] ?? '')) d += 0.12;
      if (pauses && ch === '\n') d += 0.08;
      acc += d;
      out.push(acc);
    }
    return out;
  }

  /** Human-ish typing on a fixed schedule (keystroke round-trips never slow it down). */
  async type(text: string, cps = 16) {
    const due = Recorder.schedule(text, cps);
    const start = this.now();
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      const wait = start + due[i]! * this.K - this.now();
      if (wait > 0.004) await this.page.waitForTimeout(wait * 1000);
      if (chars[i] === '\n') await this.page.keyboard.press('Enter');
      else await this.page.keyboard.type(chars[i]!);
    }
  }

  /** Log a future event (used for overlays the page never sees, e.g. the terminal). */
  logAt(t: number, type: string, data: Record<string, unknown> = {}) {
    this.events.push({ t, type, ...data });
  }

  term(state: Record<string, unknown>) {
    this.log('term', state);
  }

  save(extra: Record<string, unknown> = {}) {
    fs.writeFileSync(
      path.join(this.dir, 'capture.json'),
      JSON.stringify({ K: this.K, vw: VW, vh: VH, dsf: DSF, ...extra, frames: this.frames, events: this.events }, null, 1),
    );
  }
}
