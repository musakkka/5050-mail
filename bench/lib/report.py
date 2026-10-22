#!/usr/bin/env python3
"""Turn bench/results/**/*.json into markdown tables (stdout)."""
import json, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent / 'results'


def load(p):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def calib(d):
    env = d / 'env.txt'
    if not env.exists():
        return '?'
    m = re.search(r'"hash_per_sec_total":(\d+)', env.read_text())
    return m.group(1) if m else '?'


def cpu_peak(d, name, container):
    f = d / f'stats-{name}.tsv'
    if not f.exists():
        return ''
    vals = [float(l.split('\t')[2].rstrip('%')) for l in f.read_text().splitlines() if l.split('\t')[1:2] == [container]]
    return f'{max(vals):.0f}%' if vals else ''


f = lambda x, n=0: '' if x is None else f'{x:,.{n}f}'
out = []
send = sorted((root / 'send').glob('*')) if (root / 'send').exists() else []
if send:
    out += ['## 5050 Send', '', '| profile | layout | calib | POST /emails rps | p50 / p95 / p99 ms | batch emails/s | GET rps | worker emails/s | +webhooks emails/s, deliveries/s | SMTP relay msg/s (c16 / c64) | peak app CPU (API) |',
            '|---|---|---|---|---|---|---|---|---|---|---|']
    for d in send:
        prof, lay = d.name.split('-', 1)
        s, b, g = load(d / 'single.json'), load(d / 'batch.json'), load(d / 'get.json')
        w, ww = load(d / 'worker.json'), load(d / 'worker_webhooks.json')
        s16, s64 = load(d / 'smtp_c16.json'), load(d / 'smtp_c64.json')
        out.append('| ' + ' | '.join([
            prof, lay, calib(d),
            f(s and s['rps']), s and f"{s['p50_ms']:.0f} / {s['p95_ms']:.0f} / {s['p99_ms']:.0f}" or '',
            f(b and b['emails_per_sec']), f(g and g['rps']),
            f(w and w['emails_per_sec'], 1), ww and f"{ww['emails_per_sec']:.1f}, {ww['webhooks_per_sec']:.1f}" or '',
            f"{f(s16 and s16['msgs_per_sec'], 1)} / {f(s64 and s64['msgs_per_sec'], 1)}",
            cpu_peak(d, 'api', 'bench-send')]) + ' |')
    if any(True for d in send for _ in d.glob("quota_*.json")):
        out += ['', '### POST /emails vs. emails already sent this month', '', '| run | emails in table | rps | p50 ms | p95 ms |', '|---|---|---|---|---|']
        for d in send:
            for x in sorted(d.glob('quota_*.json'), key=lambda p: int(p.stem.split('_')[1])):
                j = load(x)
                out.append(f"| {d.name} | {int(x.stem.split('_')[1]):,} | {j['rps']:.0f} | {j['p50_ms']:.0f} | {j['p95_ms']:.0f} |")

web = sorted((root / 'webmail').glob('*')) if (root / 'webmail').exists() else []
if web:
    out += ['', '## Stalwart SMTP ingest (port 25)', '', '| profile | calib | conc 8 msg/s | conc 32 msg/s | p50 / p95 ms (c32) | failed | peak Stalwart CPU |', '|---|---|---|---|---|---|---|']
    for d in web:
        a, c = load(d / 'ingest_c8.json'), load(d / 'ingest_c32.json')
        lat = f"{c['p50_ms']:.0f} / {c['p95_ms']:.0f}" if c and c.get('p50_ms') else ''
        failed = (a or {}).get('failed', 0) + (c or {}).get('failed', 0)
        out.append(f"| {d.name} | {calib(d)} | {f(a and a['msgs_per_sec'], 1)} | {f(c and c['msgs_per_sec'], 1)} | {lat} | {failed} | {cpu_peak(d, 'ingest', 'bench-stw')} |")
    out += ['', '## Webmail BFF + Stalwart JMAP', '', '| profile | BFF layout | scenario | VUs | req/s | p50 ms | p95 ms | p99 ms | errors |', '|---|---|---|---|---|---|---|---|---|']
    for d in web:
        for lay in ('single', 'percore'):
            for sc in ('login', 'mailboxes', 'threads', 'search'):
                for v in (16, 32, 128):
                    j = load(d / f'{lay}_{sc}_v{v}.json')
                    if j:
                        out.append(f"| {d.name} | {lay} | {sc} | {v} | {j['rps']:.0f} | {j['p50_ms']:.0f} | {j['p95_ms']:.0f} | {j['p99_ms']:.0f} | {j.get('errors', 0)} |")
print('\n'.join(out) if out else 'no results', file=sys.stdout)
