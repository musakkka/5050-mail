"""Smoke test of the official Python SDK against 5050 Send (argv: api_url api_key)."""
import json, sys
import resend

resend.api_url = sys.argv[1]
resend.api_key = sys.argv[2]
out = {}
sent = resend.Emails.send({"from": "Acme <hello@acme.test>", "to": ["user@example.com"], "subject": "py", "html": "<p>from python</p>", "tags": [{"name": "sdk", "value": "python"}]})
out["sent_id"] = sent["id"]
got = resend.Emails.get(sent["id"])
out["get_subject"] = got["subject"]
domains = resend.Domains.list()
out["domains"] = [d["name"] for d in domains["data"]]
batch = resend.Batch.send([{"from": "hello@acme.test", "to": ["a@example.com"], "subject": "b1", "text": "x"}])
out["batch_n"] = len(batch["data"])
try:
    resend.Emails.send({"from": "x@unverified.test", "to": ["a@example.com"], "subject": "s", "text": "x"})
    out["error"] = None
except Exception as e:  # resend.exceptions.ResendError subclasses
    out["error"] = {"type": type(e).__name__, "code": getattr(e, "code", None), "error_type": getattr(e, "error_type", None), "message": str(e)}
print(json.dumps(out))
