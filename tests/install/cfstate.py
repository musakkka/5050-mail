#!/usr/bin/env python3
"""cfstate.py URL EXPR: evaluate EXPR against the fake Cloudflare state. Test use only.
Variables: r (DNS records), subs (sending subdomains). Prints the value; exit 0 when it is truthy."""
import json
import sys
import urllib.request

s = json.load(urllib.request.urlopen(sys.argv[1]))["result"]
v = eval(sys.argv[2], {"r": s["records"], "subs": s["subdomains"]})
print(v)
sys.exit(0 if v else 1)
