#!/usr/bin/env python3
"""5050 Mail end-to-end checks against a freshly installed server.

Stdlib only. Talks to the VM by IP while presenting the real hostnames (SNI +
Host), like `curl --resolve`, and accepts the self-signed / Caddy-internal
certificates a fake domain such as acme.test gets.

  python3 -I e2e.py --ip 1.2.3.4 --domain acme.test --admin-password X [--phase full|smoke]

Phases:
  full   every check, creates the second domain + mailbox and a Send team/key
  smoke  re-checks after re-run / upgrade: login, existing data still present

Exit code = number of failed checks (0 = pass). One line per check: PASS/FAIL.
"""
import argparse
import email.utils
import http.client
import imaplib
import json
import smtplib
import socket
import ssl
import sys
import subprocess
import time
import uuid

P = argparse.ArgumentParser()
P.add_argument("--ip", required=True)
P.add_argument("--domain", required=True)
P.add_argument("--admin-email")
P.add_argument("--admin-password", required=True)
P.add_argument("--mail-host")
P.add_argument("--webmail-host")
P.add_argument("--send-host")
P.add_argument("--api-host")
P.add_argument("--sandbox-domain", default="resend.dev")
P.add_argument("--second-domain", default="beta.test")
P.add_argument("--second-password", default="Second-Mailbox-Pw-2026!")
P.add_argument("--phase", default="full", choices=["full", "smoke"])
P.add_argument("--state", help="JSON file to store/read ids between phases")
P.add_argument("--verify-cmd", help="shell command that marks the Send domain {domain} verified (fake domains have no public DNS)")
P.add_argument("--sender", help="From address for Send checks (default hello@DOMAIN; needs --verify-cmd)")
A = P.parse_args()

DOMAIN = A.domain
ADMIN = A.admin_email or f"admin@{DOMAIN}"
MAIL_HOST = A.mail_host or f"mail.{DOMAIN}"
WEBMAIL_HOST = A.webmail_host or MAIL_HOST
SEND_HOST = A.send_host or f"send.{DOMAIN}"
API_HOST = A.api_host or f"api.{DOMAIN}"
SECOND_USER = f"bob@{A.second_domain}"

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

failures = []
state = {}
if A.state:
    try:
        with open(A.state) as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}


def save_state():
    if A.state:
        with open(A.state, "w") as f:
            json.dump(state, f, indent=2)


def check(name, fn):
    try:
        detail = fn()
        print(f"PASS  {name}" + (f"  ({detail})" if detail else ""), flush=True)
        return True
    except Exception as e:  # noqa: BLE001 - report everything
        msg = str(e).replace("\n", " ")[:600]
        print(f"FAIL  {name}  :: {type(e).__name__}: {msg}", flush=True)
        failures.append(name)
        return False


class Conn(http.client.HTTPSConnection):
    """HTTPS to the VM IP with SNI/Host = hostname (curl --resolve)."""

    def __init__(self, host, ip, port=443):
        super().__init__(host, port, context=CTX, timeout=30)
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = CTX.wrap_socket(sock, server_hostname=self.host)


class Client:
    def __init__(self, host):
        self.host = host
        self.cookies = {}

    def req(self, method, path, body=None, headers=None, expect=None):
        h = {"User-Agent": "5050-install-test/1.0", "Accept": "application/json"}
        if self.cookies:
            h["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        if method in ("POST", "PUT", "PATCH", "DELETE"):
            h["X-Requested-With"] = "install-test"
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        c = Conn(self.host, A.ip)
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        raw = r.read()
        for k, v in r.getheaders():
            if k.lower() == "set-cookie":
                name, _, rest = v.partition("=")
                val = rest.split(";", 1)[0]
                if val:
                    self.cookies[name.strip()] = val
                else:
                    self.cookies.pop(name.strip(), None)
        try:
            js = json.loads(raw) if raw else None
        except ValueError:
            js = None
        if expect is not None and r.status not in (expect if isinstance(expect, tuple) else (expect,)):
            raise AssertionError(f"{method} https://{self.host}{path} -> {r.status}: {raw[:400]!r}")
        return r.status, js, raw, dict((k.lower(), v) for k, v in r.getheaders())


# ------------------------------------------------------------------ HTTPS
def https_up(host, path="/"):
    def f():
        st, _, raw, hd = Client(host).req("GET", path)
        if st >= 500:
            raise AssertionError(f"{host}{path} -> {st}: {raw[:200]!r}")
        return f"{st} {hd.get('server', '')}".strip()
    return f


def http_redirect():
    c = http.client.HTTPConnection(A.ip, 80, timeout=15)
    c.request("GET", "/", headers={"Host": WEBMAIL_HOST})
    r = c.getresponse()
    r.read()
    if r.status not in (301, 302, 307, 308):
        raise AssertionError(f"http://{WEBMAIL_HOST}/ -> {r.status}, expected redirect to https")
    return f"{r.status} -> {r.getheader('location')}"


# ------------------------------------------------------------------ webmail + admin
web = Client(WEBMAIL_HOST)


def webmail_login(client, email_, pw, want_admin=None):
    def f():
        _, js, _, _ = client.req("POST", "/api/login", {"email": email_, "password": pw}, expect=200)
        if want_admin is not None and bool(js.get("isAdmin")) != want_admin:
            raise AssertionError(f"isAdmin={js.get('isAdmin')} expected {want_admin}")
        client.req("GET", "/api/me", expect=200)
        return f"{js.get('email')} isAdmin={js.get('isAdmin')}"
    return f


jmap_session = {}


def jmap(client, calls, using=("urn:ietf:params:jmap:core", "urn:stalwart:jmap")):
    if not jmap_session.get(client.host + str(id(client))):
        st, js, raw, _ = client.req("GET", "/jmap/session")
        if st != 200:
            st, js, raw, _ = client.req("GET", "/.well-known/jmap")
        if st != 200 or not js:
            raise AssertionError(f"JMAP session -> {st}: {raw[:300]!r}")
        jmap_session[client.host + str(id(client))] = js
    _, js, _, _ = client.req("POST", "/jmap/", {"using": list(using), "methodCalls": calls}, expect=200)
    out = []
    for name, args, tag in js["methodResponses"]:
        if name == "error":
            raise AssertionError(f"JMAP error: {args}")
        out.append(args)
    return out


def admin_create_domain():
    name = A.second_domain
    [got] = jmap(web, [["x:Domain/get", {"ids": None, "properties": ["id", "name"]}, "0"]])
    hit = [d for d in got["list"] if d["name"] == name]
    if hit:
        state["domainId"] = hit[0]["id"]
        save_state()
        return f"already exists id={hit[0]['id']}"
    [r] = jmap(web, [["x:Domain/set", {"create": {"new": {
        "name": name, "description": "install test", "isEnabled": True,
        "dkimManagement": {"@type": "Automatic", "algorithms": {"Dkim1Ed25519Sha256": True, "Dkim1RsaSha256": True}},
        "certificateManagement": {"@type": "Manual"},
        "dnsManagement": {"@type": "Manual"},
    }}}, "0"]])
    if r.get("notCreated"):
        raise AssertionError(f"notCreated: {r['notCreated']}")
    state["domainId"] = r["created"]["new"]["id"]
    save_state()
    return f"id={state['domainId']}"


def admin_create_mailbox():
    [r] = jmap(web, [["x:Account/set", {"create": {"new": {
        "@type": "User", "name": "bob", "domainId": state["domainId"], "description": "Bob Test",
        "credentials": {"0": {"@type": "Password", "secret": A.second_password}},
        "roles": {"@type": "User"}, "quotas": {},
    }}}, "0"]])
    nc = r.get("notCreated")
    if nc:
        if "exist" in json.dumps(nc).lower() or "primaryKey" in json.dumps(nc):
            return "already exists"
        raise AssertionError(f"notCreated: {nc}")
    return f"id={r['created']['new']['id']}"


# ------------------------------------------------------------------ SMTP / IMAP (Stalwart)
def smtp_submit(port=587, user=None, pw=None, to=None, subject=None):
    def f():
        s = smtplib.SMTP(A.ip, port, local_hostname="install-test.local", timeout=30)
        try:
            s.ehlo()
            if not s.has_extn("starttls"):
                raise AssertionError("no STARTTLS advertised")
            s.starttls(context=CTX)
            s.ehlo()
            if not s.has_extn("auth"):
                raise AssertionError("no AUTH advertised after STARTTLS")
            s.login(user or ADMIN, pw or A.admin_password)
            msg = (
                f"From: {user or ADMIN}\r\nTo: {to}\r\nSubject: {subject}\r\n"
                f"Date: {email.utils.formatdate()}\r\nMessage-ID: <{uuid.uuid4()}@install-test>\r\n\r\nhello from the install test\r\n"
            )
            s.sendmail(user or ADMIN, [to], msg)
        finally:
            try:
                s.quit()
            except Exception:  # noqa: BLE001
                pass
        return f"{user or ADMIN} -> {to}"
    return f


def smtp_rejects_bad_auth():
    s = smtplib.SMTP(A.ip, 587, timeout=30)
    s.starttls(context=CTX)
    try:
        s.login(ADMIN, "definitely-wrong-password")
    except smtplib.SMTPAuthenticationError as e:
        return f"rejected {e.smtp_code}"
    finally:
        try:
            s.quit()
        except Exception:  # noqa: BLE001
            pass
    raise AssertionError("wrong password accepted")


def imap_login(user, pw, want_subject=None):
    def f():
        m = imaplib.IMAP4_SSL(A.ip, 993, ssl_context=CTX, timeout=30)
        try:
            m.login(user, pw)
            typ, data = m.select("INBOX")
            if typ != "OK":
                raise AssertionError(f"SELECT INBOX {typ} {data}")
            count = int(data[0])
            if want_subject:
                deadline = time.time() + 90
                while True:
                    m.noop()
                    typ, ids = m.search(None, "SUBJECT", f'"{want_subject}"')
                    if ids and ids[0].split():
                        break
                    if time.time() > deadline:
                        raise AssertionError(f"message '{want_subject}' not in INBOX after 90s ({count} msgs)")
                    time.sleep(3)
                    m.select("INBOX")
            return f"{user} INBOX={count}" + (" + test message delivered" if want_subject else "")
        finally:
            try:
                m.logout()
            except Exception:  # noqa: BLE001
                pass
    return f


# ------------------------------------------------------------------ 5050 Send
send = Client(SEND_HOST)


def send_login():
    _, js, _, _ = send.req("POST", "/api/internal/login", {"email": ADMIN, "password": A.admin_password}, expect=200)
    if not js.get("isAdmin"):
        raise AssertionError(f"admin not superadmin in Send: {js}")
    return js.get("email")


def send_team():
    _, js, _, _ = send.req("GET", "/api/internal/teams", expect=200)
    for t in js.get("data", []):
        if t["name"] == "Install Test":
            state["teamId"] = t["id"]
            save_state()
            return f"existing {t['id']}"
    _, t, _, _ = send.req("POST", "/api/internal/teams",
                          {"name": "Install Test", "members": [{"email": ADMIN, "role": "admin"}]}, expect=(200, 201))
    state["teamId"] = t["id"]
    save_state()
    return t["id"]


def send_api_key():
    _, js, _, _ = send.req("POST", f"/api/internal/teams/{state['teamId']}/resend/api-keys", {"name": f"install-test-{int(time.time())}"}, expect=(200, 201))
    tok = js.get("token")
    if not tok or not tok.startswith("re_"):
        raise AssertionError(f"unexpected key response {js}")
    state["apiKey"] = tok
    save_state()
    return tok[:11] + "..."


def api(method, path, body=None, expect=None):
    return Client(API_HOST).req(method, path, body, {"Authorization": f"Bearer {state['apiKey']}"}, expect=expect)


SENDER = A.sender or f"hello@{DOMAIN}"


def send_domain():
    t = state["teamId"]
    _, js, _, _ = send.req("GET", f"/api/internal/teams/{t}/resend/domains", expect=200)
    hit = [d for d in js.get("data", []) if d["name"] == DOMAIN]
    if hit:
        d = hit[0]
    else:
        _, d, _, _ = send.req("POST", f"/api/internal/teams/{t}/resend/domains", {"name": DOMAIN}, expect=(200, 201))
    state["sendDomainId"] = d["id"]
    save_state()
    recs = [f"{r.get('type')} {r.get('name')}" for r in d.get("records", [])]
    if A.verify_cmd:
        out = subprocess.run(A.verify_cmd.replace("{domain}", DOMAIN), shell=True, capture_output=True, text=True, timeout=120)
        if out.returncode != 0:
            raise AssertionError(f"verify-cmd failed: {out.stderr[-300:]}")
    _, d2, _, _ = send.req("GET", f"/api/internal/teams/{t}/resend/domains/{d['id']}", expect=200)
    if d2.get("status") != "verified":
        raise AssertionError(f"status={d2.get('status')} records={recs}")
    return f"{DOMAIN} verified; records: {', '.join(recs)}"


def imap_find(user, pw, subject, timeout=120):
    """Header block of the newest message with `subject` in any folder (a fake domain
    has no DNS, so DKIM can't verify and Stalwart may file it as Junk). Records the folder."""
    m = imaplib.IMAP4_SSL(A.ip, 993, ssl_context=CTX, timeout=30)
    try:
        m.login(user, pw)
        _, boxes = m.list()
        names = []
        for b in boxes or []:
            line = b.decode()
            name = line.rsplit(' "/" ', 1)[-1].strip() if ' "/" ' in line else line.split()[-1]
            names.append(name)
        deadline = time.time() + timeout
        while True:
            for name in names:
                typ, _ = m.select(name, readonly=True)
                if typ != "OK":
                    continue
                _, ids = m.search(None, "SUBJECT", f'"{subject}"')
                if ids and ids[0].split():
                    _, data = m.fetch(ids[0].split()[-1], "(BODY.PEEK[HEADER])")
                    state.setdefault("folders", {})[subject] = name.strip('"')
                    return data[0][1].decode(errors="replace")
            if time.time() > deadline:
                raise AssertionError(f"'{subject}' not in any of {user}'s folders {names} after {timeout}s")
            time.sleep(3)
    finally:
        try:
            m.logout()
        except Exception:  # noqa: BLE001
            pass


def dkim_check(headers):
    import re
    sigs = re.findall(r"^DKIM-Signature:(.*?)(?=^\S)", headers.strip() + "\r\nX-End: 1\r\n", re.M | re.S)
    mine = [x for x in sigs if re.search(rf"d={re.escape(DOMAIN)};", x) and "s=send5050" in x]
    if not mine:
        raise AssertionError(f"no DKIM-Signature d={DOMAIN}; s=send5050 ({len(sigs)} signatures: {[x[:120] for x in sigs]})")
    return "DKIM-Signature d=%s; s=send5050" % DOMAIN


def arrived_in_inbox(subject):
    hdr = imap_find(ADMIN, A.admin_password, subject)
    res = dkim_check(hdr)
    folder = state["folders"][subject]
    if folder.upper() != "INBOX":
        raise AssertionError(f"{res} but filed in '{folder}', expected INBOX (Send's internal relay should bypass the spam filter)")
    return res + " in INBOX"


def send_email_arrives():
    return arrived_in_inbox(state["apiSubject"])


def send_relay_arrives():
    return arrived_in_inbox(state["relaySubject"])


def send_email():
    subj = f"send-api-{uuid.uuid4().hex[:8]}"
    state["apiSubject"] = subj
    _, js, _, _ = api("POST", "/emails", {
        "from": f"Install Test <{SENDER}>",
        "to": [ADMIN],
        "subject": subj, "html": "<p>hello from the 5050 Send API</p>",
    }, expect=200)
    if not js or not js.get("id"):
        raise AssertionError(f"no id: {js}")
    state["emailId"] = js["id"]
    save_state()
    return js["id"]


def send_smtp_relay():
    s = smtplib.SMTP(A.ip, 2587, local_hostname="install-test.local", timeout=30)
    try:
        s.ehlo()
        s.starttls(context=CTX)
        s.ehlo()
        s.login("resend", state["apiKey"])
        frm = SENDER
        to = ADMIN
        subj = f"send-relay-{uuid.uuid4().hex[:8]}"
        state["relaySubject"] = subj
        save_state()
        s.sendmail(frm, [to], f"From: {frm}\r\nTo: {to}\r\nSubject: {subj}\r\nDate: {email.utils.formatdate()}\r\nMessage-ID: <{uuid.uuid4()}@install-test>\r\n\r\nvia SMTP relay\r\n")
    finally:
        try:
            s.quit()
        except Exception:  # noqa: BLE001
            pass
    return "2587 STARTTLS AUTH resend:<api key>"


def send_email_status():
    deadline = time.time() + 60
    last = None
    while time.time() < deadline:
        _, js, _, _ = api("GET", f"/emails/{state['emailId']}", expect=200)
        last = js.get("last_event")
        if last and last not in ("queued", "scheduled"):
            break
        time.sleep(3)
    if last in ("failed", "bounced") or last is None:
        raise AssertionError(f"last_event={last}")
    return f"last_event={last}"


def api_rejects_bad_key():
    st, js, _, _ = Client(API_HOST).req("GET", "/emails", headers={"Authorization": "Bearer re_bad_key"})
    if st not in (400, 401, 403):
        raise AssertionError(f"bad key -> {st} {js}")
    return str(st)


# ------------------------------------------------------------------ run
check(f"HTTPS {WEBMAIL_HOST} answers", https_up(WEBMAIL_HOST))
check(f"HTTPS {SEND_HOST} answers", https_up(SEND_HOST))
check(f"HTTPS {API_HOST} answers", https_up(API_HOST, "/"))
check("HTTP :80 redirects to HTTPS", http_redirect)
check("webmail rejects wrong password", lambda: (Client(WEBMAIL_HOST).req("POST", "/api/login", {"email": ADMIN, "password": "nope-wrong-1"}, expect=401), "401")[1])
check(f"webmail login {ADMIN} (admin)", webmail_login(web, ADMIN, A.admin_password, want_admin=True))

if A.phase == "full":
    check(f"admin creates domain {A.second_domain}", admin_create_domain)
    if "domainId" in state:
        check(f"admin creates mailbox {SECOND_USER}", admin_create_mailbox)
    check(f"webmail login {SECOND_USER} (non-admin)", webmail_login(Client(WEBMAIL_HOST), SECOND_USER, A.second_password, want_admin=False))
    check("SMTP 587 rejects wrong password", smtp_rejects_bad_auth)
    subj = f"install-test-{uuid.uuid4().hex[:8]}"
    if check("SMTP 587 STARTTLS+AUTH submit admin -> bob", smtp_submit(587, to=SECOND_USER, subject=subj)):
        check(f"IMAP 993 login {SECOND_USER} + message arrived", imap_login(SECOND_USER, A.second_password, want_subject=subj))
    check(f"IMAP 993 login {ADMIN}", imap_login(ADMIN, A.admin_password))
    if check("Send dashboard login (superadmin)", send_login):
        if check("Send create team", send_team):
            if check("Send create API key", send_api_key):
                check("API rejects bad key", api_rejects_bad_key)
                if check(f"Send domain {DOMAIN} added + verified", send_domain):
                    if check("API POST /emails accepted", send_email):
                        check("API GET /emails/:id processed", send_email_status)
                        check(f"API email arrived in {ADMIN} with Send DKIM", send_email_arrives)
                    if check("Send SMTP relay 2587 STARTTLS+AUTH (API key)", send_smtp_relay):
                        check(f"relay email arrived in {ADMIN} with Send DKIM", send_relay_arrives)
else:
    check(f"webmail login {SECOND_USER} still works", webmail_login(Client(WEBMAIL_HOST), SECOND_USER, A.second_password, want_admin=False))
    check(f"IMAP 993 login {SECOND_USER}", imap_login(SECOND_USER, A.second_password))
    check(f"IMAP 993 login {ADMIN}", imap_login(ADMIN, A.admin_password))
    check("SMTP 587 STARTTLS+AUTH submit", smtp_submit(587, to=SECOND_USER, subject=f"smoke-{uuid.uuid4().hex[:6]}"))
    check("Send dashboard login", send_login)
    if state.get("apiKey"):
        check("existing API key still valid (GET /emails)", lambda: str(api("GET", "/emails", expect=200)[0]))
        if check("API POST /emails accepted", send_email):
            check(f"API email arrived in {ADMIN} with Send DKIM", send_email_arrives)

print(f"\n{len(failures)} failed" + (": " + "; ".join(failures) if failures else ""), flush=True)
sys.exit(min(len(failures), 100))
