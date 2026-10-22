"""Extract the `json Response` example of every Resend API reference page into one JSON file.
usage: python3 -I extract-doc-shapes.py <pages_dir> <out.json>"""
import json, os, re, sys
src, out = sys.argv[1], sys.argv[2]
res = {}
for f in sorted(os.listdir(src)):
    if not f.startswith('api-reference__'): continue
    t = open(os.path.join(src, f), encoding='utf-8').read()
    m = re.search(r'```json Response[^\n]*\n(.*?)\n```', t, re.S)
    if not m: continue
    body = re.sub(r'/\*.*?\*/', '', m.group(1))
    body = re.sub(r'(?m)\s//[^\n"]*$', '', body)
    try: res[f[len('api-reference__'):-3]] = json.loads(body)
    except Exception as e: res[f[len('api-reference__'):-3]] = {'__unparsed__': str(e)}
json.dump(res, open(out, 'w'), indent=1)
print(len(res), 'pages;', sum(1 for v in res.values() if isinstance(v, dict) and '__unparsed__' in v), 'unparsed')
