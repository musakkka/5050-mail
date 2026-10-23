#!/usr/bin/env python3
"""A small fake of the Cloudflare API calls install.sh makes. Test use only.

  fake_cloudflare.py PORT [SEED.json]

Tokens (the Bearer value picks the scenario):
  tok_full      user token with every permission
  tok_nodns     user token, DNS read only (cannot create records)
  tok_nosend    user token with DNS edit but no Email Sending permission
  tok_account   account-owned token (only /accounts/{id}/tokens/verify accepts it), every permission
  tok_nozone    valid user token that cannot list zones
  anything else is rejected as invalid
Zones: example.com (id zone_example), other.org (id zone_other), both in account acct_1.
GET /__state returns all DNS records and sending subdomains as JSON.
SEED.json: {"records": [{"type": "TXT", "name": "example.com", "content": "v=spf1 include:x ~all"}, ...]}
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

ZONES = [
    {"id": "zone_example", "name": "example.com", "status": "active", "account": {"id": "acct_1", "name": "Test"}},
    {"id": "zone_other", "name": "other.org", "status": "active", "account": {"id": "acct_1", "name": "Test"}},
]
PERMS = {
    "tok_full": {"zones", "dns", "send"},
    "tok_nodns": {"zones"},
    "tok_nosend": {"zones", "dns"},
    "tok_account": {"zones", "dns", "send"},
    "tok_nozone": {"dns", "send"},
}
records, subdomains, counter = [], [], [0]


def seed(path):
    for r in json.load(open(path)).get("records", []):
        add(r)


def add(r):
    counter[0] += 1
    rec = {"id": f"rec{counter[0]}", "ttl": 1, "proxied": False, **r}
    records.append(rec)
    return rec


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, status, result=None, errors=None):
        body = json.dumps({"success": not errors, "errors": errors or [], "messages": [], "result": result}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def err(self, status, code, msg):
        self.send(status, None, [{"code": code, "message": msg}])

    def token(self):
        return self.headers.get("Authorization", "").replace("Bearer ", "")

    def perms(self):
        return PERMS.get(self.token())

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def handle_any(self, method):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        if p.startswith("/client/v4"):
            p = p[len("/client/v4"):]
        if p == "/__state":
            return self.send(200, {"records": records, "subdomains": subdomains})
        tok = self.token()
        if p == "/user/tokens/verify":
            if tok in PERMS and tok != "tok_account":
                return self.send(200, {"id": "tokid", "status": "active"})
            return self.err(401, 1000, "Invalid API Token" if tok != "tok_account" else "Invalid API Token")
        if p == "/accounts/acct_1/tokens/verify":
            if tok == "tok_account":
                return self.send(200, {"id": "tokid", "status": "active"})
            return self.err(401, 1000, "Invalid API Token")
        perms = self.perms()
        if perms is None:
            return self.err(401, 10000, "Authentication error")
        if p == "/zones" and method == "GET":
            if "zones" not in perms:
                return self.err(403, 9109, "Unauthorized to access requested resource")
            zs = [z for z in ZONES if not q.get("name") or z["name"] == q["name"]]
            return self.send(200, zs)
        parts = p.strip("/").split("/")
        if len(parts) >= 3 and parts[0] == "zones" and parts[2] == "dns_records":
            if parts[1] not in {z["id"] for z in ZONES}:
                return self.err(404, 7003, "zone not found")
            if method == "GET":
                if "dns" not in perms and tok != "tok_nodns":
                    return self.err(403, 10000, "Authentication error")
                rs = [r for r in records if (not q.get("type") or r["type"] == q["type"]) and (not q.get("name") or r["name"] == q["name"])]
                return self.send(200, rs)
            if "dns" not in perms:
                return self.err(403, 10000, "Authentication error")
            if method == "POST":
                b = self.body()
                return self.send(200, add({k: b[k] for k in b if k != "comment"}))
            rid = parts[3]
            rec = next((r for r in records if r["id"] == rid), None)
            if not rec:
                return self.err(404, 81044, "Record does not exist")
            if method == "PATCH":
                rec.update(self.body())
                return self.send(200, rec)
            if method == "DELETE":
                records.remove(rec)
                return self.send(200, {"id": rid})
        if len(parts) >= 4 and parts[0] == "zones" and parts[2:4] == ["email", "sending"]:
            if "send" not in perms:
                return self.err(403, 10102, "email.sending.error.authentication.forbidden")
            if parts[4:] == ["subdomains"] and method == "GET":
                return self.send(200, subdomains)
            if parts[4:] == ["subdomains"] and method == "POST":
                sub = {"tag": "subtag", "name": self.body()["name"]}
                subdomains.append(sub)
                return self.send(200, sub)
            if parts[4:] == ["subdomains", "subtag", "dns"]:
                return self.send(200, [
                    {"type": "TXT", "name": "cf-bounce.example.com", "content": "v=spf1 include:_spf.mx.cloudflare.net ~all"},
                    {"type": "MX", "name": "cf-bounce.example.com", "content": "route1.mx.cloudflare.net", "priority": 10},
                ])
        return self.err(404, 7000, f"No route for {method} {p}")

    def do_GET(self): self.handle_any("GET")
    def do_POST(self): self.handle_any("POST")
    def do_PATCH(self): self.handle_any("PATCH")
    def do_DELETE(self): self.handle_any("DELETE")


if __name__ == "__main__":
    if len(sys.argv) > 2:
        seed(sys.argv[2])
    HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
