#!/usr/bin/env python3
"""Tiny SMTP server for testing install.sh's relay validation (stdlib only).

  fake_smtp.py PORT implicit|starttls|plain CERT KEY USER PASS

Accepts AUTH PLAIN/LOGIN for USER/PASS only (else 535). Never accepts mail.
"""
import base64, socketserver, ssl, sys

port, mode, cert, key, user, pw = sys.argv[1:7]
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)


class H(socketserver.StreamRequestHandler):
    def send(self, s):
        self.wfile.write((s + "\r\n").encode()); self.wfile.flush()

    def handle(self):
        if mode == "implicit":
            self.request = ctx.wrap_socket(self.request, server_side=True)
            self.rfile = self.request.makefile("rb"); self.wfile = self.request.makefile("wb")
        tls = mode == "implicit"
        self.send("220 fake.test ESMTP")
        while True:
            line = self.rfile.readline()
            if not line:
                return
            cmd = line.decode().strip(); up = cmd.upper()
            if up.startswith("EHLO") or up.startswith("HELO"):
                self.send("250-fake.test")
                if mode == "starttls" and not tls: self.send("250-STARTTLS")
                if tls or mode == "plain": self.send("250-AUTH PLAIN LOGIN")
                self.send("250 8BITMIME")
            elif up == "STARTTLS":
                self.send("220 Ready")
                self.request = ctx.wrap_socket(self.request, server_side=True)
                self.rfile = self.request.makefile("rb"); self.wfile = self.request.makefile("wb"); tls = True
            elif up.startswith("AUTH PLAIN"):
                if len(cmd.split()) < 3:
                    self.send("334 "); cmd = "AUTH PLAIN " + self.rfile.readline().decode().strip()
                parts = base64.b64decode(cmd.split()[2]).split(b"\0")
                ok = len(parts) == 3 and parts[1].decode() == user and parts[2].decode() == pw
                self.send("235 2.7.0 Authentication successful" if ok else "535 5.7.8 Authentication credentials invalid")
            elif up == "AUTH LOGIN":
                self.send("334 VXNlcm5hbWU6"); u = base64.b64decode(self.rfile.readline()).decode()
                self.send("334 UGFzc3dvcmQ6"); p = base64.b64decode(self.rfile.readline()).decode()
                self.send("235 2.7.0 ok" if (u, p) == (user, pw) else "535 5.7.8 Authentication credentials invalid")
            elif up == "NOOP": self.send("250 OK")
            elif up == "QUIT": self.send("221 Bye"); return
            else: self.send("502 not implemented")


class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

S(("127.0.0.1", int(port)), H).serve_forever()
