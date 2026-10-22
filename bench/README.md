# 5050 Mail benchmarks

Reproducible load tests for the three parts of a 5050 Mail install:

| What | Script | Load generator |
|---|---|---|
| 5050 Send API: `POST /emails`, `POST /emails/batch` (100 per call), `GET /emails/{id}` | `send/run.sh` | k6 |
| 5050 Send worker: queue drain (send_email jobs/s) with and without webhook fan-out | `send/run.sh` | backlog left by the API phase, webhook sink `send/sink.mjs` |
| 5050 Send SMTP relay: STARTTLS + AUTH, messages/s | `send/run.sh` | `send/smtp-load.mjs` (nodemailer, pooled) |
| Stalwart MX ingest: SMTP port 25, messages/s | `webmail/run.sh` | `send/smtp-load.mjs` |
| Webmail BFF in front of Stalwart JMAP: login, mailbox list, inbox thread page, full-text search | `webmail/run.sh` | k6 (`webmail/k6-webmail.js`) |

Everything runs in Docker on one machine. Nothing talks to the internet except Stalwart's own
DNS lookups for inbound mail (SPF/DMARC of the sender domain), as on a real MX. Send uses a no-op
transport, so its numbers are the cost of 5050 Send itself, not of the next mail hop.

## How a "VM" is simulated

Each profile pins the server containers (app + Postgres, or Stalwart + BFF + Postgres) to the same
cores with `--cpuset-cpus` and caps memory with `--memory`, so the app and its database compete for
the same vCPUs like on a real small VM. Load generators run on the remaining cores.

| Profile | Server cores | Memory caps | Load generator cores |
|---|---|---|---|
| `2c4g` | 0-1 | Send: app 3 GB + Postgres 1 GB. Mail: Stalwart 3 GB + BFF 1 GB (+512 MB sessions DB) | 4-7 |
| `4c8g` | 0-3 | Send: app 6 GB + Postgres 2 GB. Mail: Stalwart 6 GB + BFF 2 GB (+512 MB) | 4-7 |
| `8c` | 0-7 (uncapped) | generous | 0-7 (shared, so lower than a real 8-core box) |

Layouts: `single` = one Node process per role; `percore` = one process per server core
(node:cluster sharing the listening socket). The Send harness (`send/server.mjs`) forks roles
the same way `apps/send/src/cluster.ts` does (shared port, FOR UPDATE SKIP LOCKED job claims,
Postgres pool 5 per process as in `deploy/docker-compose.yml`). The webmail BFF is started
through its own `dist/server/cluster.js` with `WEB_CONCURRENCY` and Postgres sessions.

Each run first records `uptime` and a CPU calibration (`lib/calibrate.sh`: SHA-256 blocks/s on
the server cores) into `results/**/env.txt`. Compare calibrations before comparing two runs: if
the number is far lower than on an idle machine, something else was using the CPU.
`lib/sampler.sh` writes container CPU/memory once a second to `results/**/stats-*.tsv`; a
container above 100% is using more than one core.

## Requirements

- Docker (Docker Desktop: give the VM all cores and at least 8 GB)
- Node 22+, `npm ci` done in `apps/send` and `apps/webmail` (the build scripts do it if missing)
- Images: `postgres:16-alpine`, `node:22-alpine`, `grafana/k6:1.3.0`, `stalwartlabs/stalwart:v0.16.27`
- python3, curl

## Run

```bash
cd bench
./send/build.sh            # compiles apps/send to .bench-out/sendapp (source tree untouched)
./webmail/build.sh         # compiles the webmail BFF to .bench-out/webmail

for p in 2c4g 4c8g 8c; do
  for l in single percore; do PROFILE=$p LAYOUT=$l ./send/run.sh; done
  PROFILE=$p ./webmail/run.sh            # Stalwart ingest + BFF single and percore
done
PROFILE=4c8g LAYOUT=single QUOTA_SCAN=1 ./send/run.sh   # API speed vs. emails already sent this month

python3 lib/report.py > results/summary.md               # tables from the JSON results
```

Knobs: `DURATION` (k6 phase length, default 30s), `INGEST_TOTAL` (messages for the Stalwart
ingest phase, default 6400), `SEND_DIR` / `WEB_DIR` (benchmark another checkout),
`UNTHROTTLE=0` (keep Stalwart's production rate limits, see below).

On a real VM, skip the profiles: run the same scripts with `PROFILE=8c` and edit the `case`
block so `VM_CPUS` is all cores and the load generator runs on a second machine (point k6's
`BASE` at the VM).

## What the bench changes from production defaults

- **Send**: `DEFAULT_RATE_LIMIT` and the bench team's `rate_limit` are raised to 1,000,000/s and
  the monthly quota to 2 billion, so the tests measure capacity rather than the limiter.
  Transport is a no-op counter; Cloudflare is faked.
- **Stalwart** (`stalwart/setup.sh`, `UNTHROTTLE=1`): production defaults allow 1,000
  authenticated HTTP requests per minute per account, 5 SMTP connections per second per sender
  IP, and 25 messages per hour per sender domain and recipient. A load test comes from one IP
  and a few accounts, so these are lifted. With them on, a single client gets 429s / 452s long
  before the server is busy. That is the intended abuse protection, not a capacity limit.
  Stalwart also caps concurrent JMAP requests at 4 per account, so the webmail test spreads
  load over 32 mailboxes (u01..u32@bench.test).
- **Webmail BFF**: login rate limits raised; the background mail worker is off (`WORKER=0`).

## Files

```
send/build.sh        compile apps/send
send/server.mjs      bench harness: seed DB, fork web/worker/smtp processes
send/run.sh          one profile x layout: API, worker, webhooks, SMTP relay (+ QUOTA_SCAN)
send/k6-api.js       k6 script for the Send API
send/smtp-load.mjs   SMTP client (Send relay and Stalwart MX)
send/sink.mjs        webhook receiver that counts deliveries
stalwart/setup.sh    throw-away Stalwart with bench.test and 32 mailboxes
webmail/build.sh     compile the webmail BFF
webmail/run.sh       Stalwart ingest + BFF (single / percore)
webmail/k6-webmail.js
lib/calibrate.sh     CPU availability check
lib/sampler.sh       container CPU/memory sampler
lib/report.py        results/**.json -> markdown tables
results/             raw JSON, logs, CPU samples from the runs quoted in RESULTS.md
```
