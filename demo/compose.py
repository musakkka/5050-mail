#!/usr/bin/env python3
"""
Composites the recording into the landing-page demo video.

  python compose.py [--capture .work/capture] [--assets .work/assets] [--out ../site/public/demo]

Per output frame (1920x1080, 60 fps): brand background, the browser window (bar + screencast frame)
with rounded corners, an ink border and a hard offset shadow, a smooth camera (zoom/pan eased between
logged targets), the re-drawn cursor with click rings, a floating terminal window, and crossfaded
title cards between sections. Frames are rendered in parallel chunks, then encoded to H.264 mp4 and
VP9 webm (size-capped), plus poster.jpg and a short seamless hero loop.

Idea credits: the cursor smoothing / auto-zoom / framed-background look follows Recordly
(github.com/webadderallorg/recordly, AGPL-3.0); this is an independent, scripted implementation.
"""
import argparse
import bisect
import json
import math
import os
import shutil
import subprocess
import sys
from multiprocessing import Pool

from PIL import Image

W, H, FPS = 1920, 1080, 60
# window layout in canvas ("base") coordinates at zoom 1
WX, WY, WW, WH, BAR = 168, 67, 1584, 946, 44
S0 = 1.1  # CSS px -> base px (1440 x 820 viewport -> 1584 x 902)
PAD = 34  # camera keeps this much background around the window edges when it can
XF = 0.5  # crossfade seconds
INK = (28, 26, 36)
SHADOW = 10
CARD_DUR = {'intro': 2.5, 'mail': 1.5, 'admin': 1.5, 'send': 1.5, 'outro': 3.4}
TIMELINE = [('card', 'intro'), ('card', 'mail'), ('clip', 'mail'), ('card', 'admin'), ('clip', 'admin'),
            ('card', 'send'), ('clip', 'send'), ('card', 'outro')]


def ease(p):
    p = min(1.0, max(0.0, p))
    return 4 * p * p * p if p < 0.5 else 1 - (-2 * p + 2) ** 3 / 2


def ease_out(p):
    p = min(1.0, max(0.0, p))
    return 1 - (1 - p) ** 3


class Capture:
    def __init__(self, d):
        self.dir = d
        c = json.load(open(os.path.join(d, 'capture.json')))
        self.K = c['K']
        self.frames = sorted(c['frames'], key=lambda f: f['t'])
        self.ft = [f['t'] for f in self.frames]
        ev = sorted(c['events'], key=lambda e: e['t'])
        self.clips = {}
        cur = None
        for e in ev:
            if e['type'] == 'clip':
                cur = e
            elif e['type'] == 'clipEnd' and cur:
                self.clips[cur['name']] = (cur['t'], e['t'], cur['cursor'])
                cur = None
        # hard cuts (e.g. a loading skeleton), as wall-clock intervals removed from the video
        self.cuts, a = [], None
        for e in ev:
            if e['type'] == 'cutStart':
                a = e['t']
            elif e['type'] == 'cutEnd' and a is not None:
                self.cuts.append((a, e['t']))
                a = None
        self.moves = [e for e in ev if e['type'] == 'move']
        self.mt = [m['t0'] for m in self.moves]
        self.clicks = [e for e in ev if e['type'] == 'click']
        self.urls = [e for e in ev if e['type'] == 'url' and e['url'].startswith('http')]
        self.ut = [u['t'] for u in self.urls]
        self.terms = [e for e in ev if e['type'] == 'term']
        self.tt = [e['t'] for e in self.terms]
        self.vis = [e for e in ev if e['type'] == 'cursor']
        # camera transitions: (t0, t1, from(z,fx,fy), to(z,fx,fy))
        self.cams = []
        state = (1.0, W / 2, H / 2)
        for e in ev:
            if e['type'] != 'cam':
                continue
            start = self.cam_at(e['t'], state)
            z = e['zoom']
            tgt = (z,) + clamp_focus(z, WX + e['x'] * S0, WY + BAR + e['y'] * S0)
            self.cams.append((e['t'], e['t'] + e['dur'] * self.K, start, tgt))
        self.ct = [c[0] for c in self.cams]

    def cam_at(self, w, default=(1.0, W / 2, H / 2)):
        cams = getattr(self, 'cams', [])
        i = bisect.bisect_right([c[0] for c in cams], w) - 1
        if i < 0:
            return default
        t0, t1, a, b = cams[i]
        p = ease((w - t0) / (t1 - t0)) if t1 > t0 else 1
        return tuple(a[k] + (b[k] - a[k]) * p for k in range(3))

    def camera(self, w):
        i = bisect.bisect_right(self.ct, w) - 1
        if i < 0:
            return (1.0, W / 2, H / 2)
        t0, t1, a, b = self.cams[i]
        p = ease((w - t0) / (t1 - t0)) if t1 > t0 else 1
        return tuple(a[k] + (b[k] - a[k]) * p for k in range(3))

    def wall(self, name, t):
        w = self.clips[name][0] + t * self.K
        for a, b in self.cuts:
            if a <= w:
                w += b - a
        return w

    def duration(self, name):
        t0, t1, _ = self.clips[name]
        return (t1 - t0 - sum(b - a for a, b in self.cuts if t0 <= a < t1)) / self.K

    def frame_at(self, w):
        i = max(0, bisect.bisect_right(self.ft, w) - 1)
        return os.path.join(self.dir, 'frames', self.frames[i]['file'])

    def cursor(self, w, clip):
        i = bisect.bisect_right(self.mt, w) - 1
        if i < 0 or self.moves[i]['t0'] < self.clips[clip][0] - 60:
            c = self.clips[clip][2]
            return c['x'], c['y']
        m = self.moves[i]
        if w >= m['t1']:
            return m['to']['x'], m['to']['y']
        e = ease((w - m['t0']) / (m['t1'] - m['t0']))
        a, c, b = m['from'], m['ctrl'], m['to']
        x = (1 - e) ** 2 * a['x'] + 2 * (1 - e) * e * c['x'] + e * e * b['x']
        y = (1 - e) ** 2 * a['y'] + 2 * (1 - e) * e * c['y'] + e * e * b['y']
        return x, y

    def cursor_alpha(self, w):
        a = 1.0
        for e in self.vis:
            if e['t'] > w:
                break
            p = min(1, (w - e['t']) / (0.25 * self.K))
            a = p if e['visible'] else 1 - p
        return a

    def url(self, w):
        i = max(0, bisect.bisect_right(self.ut, w) - 1)
        return self.urls[i]['url']

    def term(self, w):
        """(state, alpha, dy) of the floating terminal, or None."""
        i = bisect.bisect_right(self.tt, w) - 1
        if i < 0:
            return None
        e = self.terms[i]
        if e.get('open'):
            j = i
            while j > 0 and self.terms[j - 1].get('open'):
                j -= 1
            p = ease_out((w - self.terms[j]['t']) / (0.4 * self.K))
            return e, p, (1 - p) * 60
        # closing: fade the last open state out
        j = i - 1
        if j < 0 or not self.terms[j].get('open'):
            return None
        p = (w - e['t']) / (0.32 * self.K)
        if p >= 1:
            return None
        return self.terms[j], 1 - ease(p), ease(p) * 40


def term_key(st):
    """Same key render-assets.ts used (JSON.stringify of the defined fields)."""
    return json.dumps({k: st[k] for k in ('lines', 'caret', 'status') if st.get(k) is not None}, separators=(',', ':'), ensure_ascii=False)


def clamp_focus(z, fx, fy):
    hw, hh = W / 2 / z, H / 2 / z
    bx0, bx1, by0, by1 = WX - PAD, WX + WW + PAD, WY - PAD, WY + WH + PAD
    fx = (bx0 + bx1) / 2 if 2 * hw >= bx1 - bx0 else min(max(fx, bx0 + hw), bx1 - hw)
    fy = (by0 + by1) / 2 if 2 * hh >= by1 - by0 else min(max(fy, by0 + hh), by1 - hh)
    return fx, fy


class Renderer:
    def __init__(self, cap_dir, assets_dir):
        self.cap = Capture(cap_dir)
        self.adir = assets_dir
        self.man = json.load(open(os.path.join(assets_dir, 'manifest.json')))
        self.bg = Image.open(self.p('bg.png')).convert('RGB')
        self.mask = Image.open(self.p('frame_mask.png')).split()[-1]
        bd = Image.open(self.p('frame_border.png')).convert('RGBA')
        self.border_rgb, self.border_a = bd.convert('RGB'), bd.split()[-1]
        cur = Image.open(self.p('cursor.png')).convert('RGBA')
        self.cursor = cur
        self.ring = Image.open(self.p('ring.png')).convert('RGBA')
        self.cache = {}
        self.scaled = {}  # (asset, camera) -> resized piece, for the window mask/border/bar/shadow
        self.last = (None, None)  # (key, canvas before the cursor) for unchanged frames

    def p(self, f):
        return os.path.join(self.adir, f)

    def img(self, path, mode='RGB'):
        im = self.cache.get(path)
        if im is None:
            if len(self.cache) > 24:
                self.cache.pop(next(iter(self.cache)))
            im = Image.open(path)
            im = im.convert(mode)
            self.cache[path] = im
        return im

    # ---------------------------------------------------------------- drawing helpers
    @staticmethod
    def mapped(src_size, rect, cam):
        """Destination box (ints, clipped to canvas) and the matching float source box for a source
        image covering `rect` (base coords) under camera `cam`."""
        z, fx, fy = cam
        bx, by, bw, bh = rect
        sx0, sy0 = (bx - fx) * z + W / 2, (by - fy) * z + H / 2
        sx1, sy1 = sx0 + bw * z, sy0 + bh * z
        dx0, dy0 = max(0, math.floor(sx0)), max(0, math.floor(sy0))
        dx1, dy1 = min(W, math.ceil(sx1)), min(H, math.ceil(sy1))
        if dx1 <= dx0 or dy1 <= dy0:
            return None
        kx, ky = src_size[0] / (sx1 - sx0), src_size[1] / (sy1 - sy0)
        box = ((dx0 - sx0) * kx, (dy0 - sy0) * ky, (dx1 - sx0) * kx, (dy1 - sy0) * ky)
        box = (max(0, box[0]), max(0, box[1]), min(src_size[0], box[2]), min(src_size[1], box[3]))
        return (dx0, dy0, dx1, dy1), box

    def layer(self, canvas, src, rect, cam, mask=None, color=None, resample=Image.BICUBIC, key=None):
        m = self.mapped(src.size, rect, cam)
        if not m:
            return
        (dx0, dy0, dx1, dy1), box = m
        size = (dx1 - dx0, dy1 - dy0)
        ck = (key, rect, cam) if key else None
        piece = self.scaled.get(ck) if ck else None
        if piece is None:
            piece = src.resize(size, resample, box=box)
            if ck:
                if len(self.scaled) > 64:
                    self.scaled.clear()
                self.scaled[ck] = piece
        if color is not None:
            canvas.paste(color, (dx0, dy0, dx1, dy1), piece)
        elif mask is not None:
            canvas.paste(piece, (dx0, dy0), mask.resize(size, Image.BILINEAR, box=box) if mask.size == src.size else mask)
        elif piece.mode == 'RGBA':
            canvas.paste(piece, (dx0, dy0), piece)
        else:
            canvas.paste(piece, (dx0, dy0))

    # ---------------------------------------------------------------- scenes
    def card(self, name, t):
        files = self.man['cards'][name]
        i = min(len(files) - 1, int(t * FPS))
        return self.img(self.p(files[i])).copy()

    def clip(self, name, t):
        cap = self.cap
        w = cap.wall(name, t)
        cam = tuple(round(v, 5) for v in cap.camera(w))
        z = cam[0]
        url = self.man['display'].get(cap.url(w), '')
        frame_path = cap.frame_at(w)
        tm = cap.term(w)
        tkey = (term_key(tm[0]), round(tm[1], 3), round(tm[2], 2)) if tm else None
        key = (frame_path, url, cam, tkey)
        if self.last[0] == key:
            canvas = self.last[1].copy()
        else:
            canvas = self.window(cam, url, frame_path, tm)
            self.last = (key, canvas.copy())
        return self.cursor_layer(canvas, name, w, cam)

    def window(self, cam, url, frame_path, tm):
        canvas = self.bg.copy()
        z = cam[0]
        # hard ink shadow
        self.layer(canvas, self.mask, (WX + SHADOW, WY + SHADOW, WW, WH), cam, color=INK, resample=Image.BILINEAR, key='mask')
        # window: bar + page, clipped to the rounded frame
        win = Image.new('RGB', (W, H))
        bar = self.man['bars'].get(url)
        if bar:
            self.layer(win, self.img(self.p(bar)), (WX, WY, WW, BAR), cam, key=bar)
        self.layer(win, self.img(frame_path), (WX, WY + BAR, WW, WH - BAR), cam)
        m = self.mapped(self.mask.size, (WX, WY, WW, WH), cam)
        if m:
            (dx0, dy0, dx1, dy1), box = m
            ck = ('frame', cam)
            if ck not in self.scaled:
                self.scaled[ck] = (self.mask.resize((dx1 - dx0, dy1 - dy0), Image.BILINEAR, box=box),
                                   self.border_a.resize((dx1 - dx0, dy1 - dy0), Image.BILINEAR, box=box))
            mk, bd = self.scaled[ck]
            canvas.paste(win.crop((dx0, dy0, dx1, dy1)), (dx0, dy0), mk)
            canvas.paste(INK, (dx0, dy0, dx1, dy1), bd)
        # floating terminal
        if tm:
            st, alpha, dy = tm
            f = self.man['terms'].get(term_key(st))
            if f:
                tim = self.img(self.p(f), 'RGBA')
                bw, bh = tim.size[0] / 2, tim.size[1] / 2
                rect = (W / 2 - bw / 2 + 40, H / 2 - bh / 2 + 70 + dy, bw, bh)
                if alpha < 1:
                    tim = tim.copy()
                    tim.putalpha(tim.split()[-1].point(lambda v: int(v * alpha)))
                self.layer(canvas, tim, rect, cam)
        return canvas

    def cursor_layer(self, canvas, name, w, cam):
        cap = self.cap
        z = cam[0]
        # cursor + click rings
        ca = cap.cursor_alpha(w)
        if ca > 0.01:
            cx, cy = cap.cursor(w, name)
            bxp, byp = WX + cx * S0, WY + BAR + cy * S0
            sx, sy = (bxp - cam[1]) * z + W / 2, (byp - cam[2]) * z + H / 2
            press = 1.0
            for c in cap.clicks:
                if c['t'] > w:
                    break
                age = (w - c['t']) / cap.K
                if age < 0.5:
                    p = ease_out(age / 0.5)
                    r = (14 + 30 * p) * z ** 0.5
                    ring = self.ring.resize((max(2, int(2 * r)), max(2, int(2 * r))), Image.BICUBIC)
                    a = ring.split()[-1].point(lambda v, k=(1 - p) * 0.9 * ca: int(v * k))
                    canvas.paste(ring, (int(sx - r), int(sy - r)), a)
                if age < 0.2:
                    press = min(press, 0.84 + 0.16 * abs(age - 0.1) / 0.1)
            sc = 0.5 * press * z ** 0.55 * 1.05  # cursor.png is 2x
            cw = max(2, int(self.cursor.size[0] * sc))
            cur = self.cursor.resize((cw, cw), Image.BICUBIC)
            a = cur.split()[-1]
            if ca < 1:
                a = a.point(lambda v: int(v * ca))
            # the arrow tip is at (8, 4) of the 40x40 sprite
            canvas.paste(cur, (int(sx - 8 / 40 * cw), int(sy - 4 / 40 * cw)), a)
        return canvas

    # ---------------------------------------------------------------- timeline
    def timeline(self):
        items, s = [], 0.0
        for kind, name in TIMELINE:
            if kind == 'clip' and name not in self.cap.clips:
                continue
            d = CARD_DUR[name] if kind == 'card' else self.cap.duration(name)
            items.append((s, d, kind, name))
            s += d - XF
        return items, s + XF

    def frame(self, T, items):
        live = [it for it in items if it[0] - 1e-9 <= T < it[0] + it[1]]
        out = None
        for s, d, kind, name in live[:2]:
            t = T - s
            im = self.card(name, t) if kind == 'card' else self.clip(name, t)
            if out is None:
                out = im
            else:
                out = Image.blend(out, im, ease(t / XF))
        return out if out is not None else self.bg.copy()


R = None


def _init(cap_dir, assets_dir):
    global R
    R = Renderer(cap_dir, assets_dir)


def _chunk(args):
    idx, a, b, out = args
    items, _ = R.timeline()
    ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                           '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p', out], stdin=subprocess.PIPE)
    for n in range(a, b):
        ff.stdin.write(R.frame(n / FPS, items).tobytes())
    ff.stdin.close()
    ff.wait()
    return idx


def run(cmd):
    print('+', ' '.join(cmd[:6]), '…' if len(cmd) > 6 else '')
    subprocess.run(cmd, check=True)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('--capture', default=os.path.join(here, '.work/capture'))
    ap.add_argument('--assets', default=os.path.join(here, '.work/assets'))
    ap.add_argument('--work', default=os.path.join(here, '.work/compose'))
    ap.add_argument('--out', default=os.path.join(here, '..', 'site/public/demo'))
    ap.add_argument('--max-mb', type=float, default=14.5)
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 4)
    ap.add_argument('--preview', type=float, default=0, help='only render the first N seconds')
    ap.add_argument('--stills', default='', help='comma-separated seconds to dump as PNG stills (no video)')
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)

    r = Renderer(a.capture, a.assets)
    items, total = r.timeline()
    for s, d, kind, name in items:
        print(f'  {s:6.2f}s  {kind:4} {name:6} {d:5.2f}s')
    print(f'total {total:.2f}s')
    if a.stills:
        for x in a.stills.split(','):
            r.frame(float(x), items).save(os.path.join(a.work, f'still_{float(x):06.2f}.png'))
        return
    if a.preview:
        total = min(total, a.preview)
    n = int(round(total * FPS))
    step = math.ceil(n / a.jobs)
    jobs = [(i, s, min(n, s + step), os.path.join(a.work, f'chunk_{i:02d}.mkv')) for i, s in enumerate(range(0, n, step))]
    with Pool(a.jobs, initializer=_init, initargs=(a.capture, a.assets)) as pool:
        for i in pool.imap_unordered(_chunk, jobs):
            print(f'  chunk {i} done')
    lst = os.path.join(a.work, 'chunks.txt')
    with open(lst, 'w') as f:
        for j in jobs:
            f.write(f"file '{j[3]}'\n")
    master = os.path.join(a.work, 'master.mkv')
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', master])
    if a.preview:
        print('preview →', master)
        return

    # ---- final encodes, capped at --max-mb
    kbps = int(a.max_mb * 8 * 1024 * 0.96 / total)
    mp4 = os.path.join(a.out, 'demo.mp4')
    webm = os.path.join(a.out, 'demo.webm')
    plog = os.path.join(a.work, 'x264pass')
    x264 = ['-c:v', 'libx264', '-preset', 'slow', '-tune', 'animation', '-b:v', f'{kbps}k', '-maxrate', f'{kbps * 3}k', '-bufsize', f'{kbps * 4}k',
            '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-g', str(FPS * 4), '-passlogfile', plog]
    run(['ffmpeg', '-v', 'error', '-y', '-i', master, *x264, '-pass', '1', '-an', '-f', 'mp4', os.devnull])
    run(['ffmpeg', '-v', 'error', '-y', '-i', master, *x264, '-pass', '2', '-an', '-movflags', '+faststart', mp4])
    vlog = os.path.join(a.work, 'vp9pass')
    vp9 = ['-c:v', 'libvpx-vp9', '-b:v', f'{int(kbps * 0.85)}k', '-maxrate', f'{kbps * 2}k', '-row-mt', '1', '-tile-columns', '2', '-g', str(FPS * 4),
           '-deadline', 'good', '-passlogfile', vlog, '-pix_fmt', 'yuv420p']
    run(['ffmpeg', '-v', 'error', '-y', '-i', master, *vp9, '-cpu-used', '4', '-pass', '1', '-an', '-f', 'webm', os.devnull])
    run(['ffmpeg', '-v', 'error', '-y', '-i', master, *vp9, '-cpu-used', '2', '-pass', '2', '-an', webm])

    # ---- poster: the inbox, a beat into the webmail clip
    mail = next((it for it in items if it[2] == 'clip' and it[3] == 'mail'), items[0])
    poster_t = mail[0] + XF + 0.3
    run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{poster_t:.3f}', '-i', master, '-frames:v', '1', '-q:v', '2', os.path.join(a.out, 'poster.jpg')])

    # ---- hero loop: 12 s from the webmail clip, 1280x720@30, last 0.6 s dissolves into the first frame
    hs, hl, hx = mail[0] + XF, 12.6, 0.6
    hero = os.path.join(a.work, 'hero_src.mkv')
    run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{hs:.3f}', '-t', f'{hl:.3f}', '-i', master, '-vf', 'scale=1280:720:flags=lanczos,fps=30',
         '-c:v', 'libx264', '-crf', '12', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', hero])
    loop = (f'[0:v]split[a][b];[a]trim=start={hx},setpts=PTS-STARTPTS[main];[b]trim=0:{hx},setpts=PTS-STARTPTS[head];'
            f'[main][head]xfade=transition=fade:duration={hx}:offset={hl - 2 * hx:.3f}[v]')
    run(['ffmpeg', '-v', 'error', '-y', '-i', hero, '-filter_complex', loop, '-map', '[v]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '27',
         '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', os.path.join(a.out, 'hero.mp4')])
    run(['ffmpeg', '-v', 'error', '-y', '-i', hero, '-filter_complex', loop, '-map', '[v]', '-c:v', 'libvpx-vp9', '-crf', '38', '-b:v', '0',
         '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-an', os.path.join(a.out, 'hero.webm')])
    run(['ffmpeg', '-v', 'error', '-y', '-ss', '0', '-i', os.path.join(a.out, 'hero.mp4'), '-frames:v', '1', '-q:v', '3', os.path.join(a.out, 'hero-poster.jpg')])
    for f in sorted(os.listdir(a.out)):
        print(f'  {f:16} {os.path.getsize(os.path.join(a.out, f)) / 1e6:6.2f} MB')


if __name__ == '__main__':
    main()
