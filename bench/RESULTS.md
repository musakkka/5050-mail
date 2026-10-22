# Benchmark results

**Status: tooling done, numbers not citable yet.** The runs below were made on a developer
laptop that was saturated by other work during every run. The 1-minute load average was 43 to 225
on 8 cores, CPU idle was 0%, and swap was full. Throughput moved by up to 10x between identical
runs, in step with the CPU calibration. Use the tables to see what the scripts measure, not how
fast 5050 Mail is. Before the landing page or docs quote a req/s or msgs/s figure, rerun on an idle
machine or a real 2 vCPU / 4 GB and 4 vCPU / 8 GB VM (see README.md, "Run").

What the site **can** say today (backed by the data below and by the code):

- 5050 Send and the webmail BFF run one process per CPU core. The 4-core profile's Send container
  peaked at **425-486% CPU** with one process per core, which means all 4 cores were busy. The
  single-process layout peaked at 236-260%.
- Every Send role (API, worker, SMTP relay) scales out across processes and machines behind one
  Postgres. Queue jobs are claimed with `FOR UPDATE SKIP LOCKED`.
- In the bench, no request failed in any Send or webmail scenario (0 errors, 0 failed SMTP
  transactions). Under heavy CPU starvation the services slowed down but did not drop requests.
- The benchmark suite is reproducible: `bench/README.md`.

## Machine

- Apple M1 (4 performance + 4 efficiency cores), 16 GB RAM, macOS 26.2
- Docker Desktop 28.3.0 with 8 vCPUs and 7.65 GB for the Linux VM
- Images: postgres:16-alpine, node:22-alpine (Node 22), grafana/k6:1.3.0, stalwartlabs/stalwart:v0.16.27
- Code: `apps/send` and `apps/webmail` in this repo as of 2026-10-22 (after cluster mode landed)
- Profile used: `4c8g`. The server containers were pinned to cores 0-3 with app 6 GB and Postgres 2 GB
  (Stalwart 6 GB, BFF 2 GB and session DB 512 MB for the mail runs). k6 and the SMTP clients ran on cores 4-7.
- The 2c4g and 8c profiles were not run because the host never became idle enough for the runs to mean anything.

`calib` is the CPU calibration taken just before each run: SHA-256 64 KiB blocks/s on the server
cores with 4 threads (`lib/calibrate.sh`). Higher means more CPU was actually available. On this
host it ranged from 4,100 to 34,900 across the day. One core alone measured 7,766 at the best
moment, so an idle 4-core set should give about 30,000 or more. Every run below got less than that.

## 5050 Send (no-op transport, Postgres pool 5 per process)

| run | layout | calib | host load (1m) | POST /emails req/s | p50 / p95 / p99 ms | batch (100/call) emails/s | GET /emails/{id} req/s | peak app CPU |
|---|---|---|---|---|---|---|---|---|
| 1 | 4 processes | 23,492 | 43 | 105 | 525 / 1,211 / 1,721 | 260 | 248 | 425% |
| 2 | 1 process | 9,871 | 176 | 11 | 3,645 / 13,193 / 13,615 | 317 | 159 | 236% |
| 3 | 1 process | 5,594 | 144 | 31 | 1,617 / 4,569 / 4,986 | 61 | 124 | 260% |
| 4 | 4 processes | 5,046 | 178 | 9 | 4,338 / 16,236 / 17,717 | 22 | 43 | 486% |

64 virtual users for single sends and GET, 8 for batch, 20 s per phase. Runs 1 and 2 also measured
the worker and the SMTP relay:

| run | worker drain, emails/s | worker + 3 webhook endpoints: emails/s, webhook deliveries/s | SMTP relay (STARTTLS + AUTH) msgs/s, 16 / 64 connections |
|---|---|---|---|
| 1 (4 web, 4 worker, 4 smtp procs) | 50.2 | 5.2, 10.9 | 13.1 / 13.7 (p50 849 ms at 16) |
| 2 (1 process each) | 26.6 | 2.6, 6.7 | 67.1 / 72.0 |

Read across the rows and the throughput follows `calib` and host load more closely than it follows
the layout. That is why none of these numbers is a capacity figure.

## Stalwart SMTP ingest (port 25, 4 KB text, 32 local mailboxes, throttles lifted)

| calib | 8 connections | 32 connections | p50 / p95 ms at 32 | failed | peak Stalwart CPU |
|---|---|---|---|---|---|
| 16,812 | 13.7 msgs/s | 45.6 msgs/s | 614 / 1,311 | 0 of 3,200 | 145% |

Each message includes Stalwart's real inbound checks, which do DNS lookups for SPF and DMARC of
the sender domain over the internet. Those lookups account for much of the per-message latency,
as they would on a real MX.

## Webmail BFF in front of Stalwart JMAP (same 4-core set, Postgres sessions)

| BFF layout | scenario | VUs | req/s | p50 ms | p95 ms | errors |
|---|---|---|---|---|---|---|
| 1 process | login (Stalwart argon2id check + session) | 16 | 133 | 76 | 324 | 0 |
| 1 process | mailbox list | 32 / 128 | 760 / 842 | 27 / 117 | 92 / 349 | 0 |
| 1 process | inbox page, 50 threads (the SPA's 4-call batch) | 32 / 128 | 500 / 504 | 27 / 208 | 179 / 583 | 0 |
| 1 process | full-text search + snippets | 32 / 128 | 36 / 70 | 299 / 1,753 | 4,748 / 5,505 | 0 |
| 4 processes | login | 16 | 42 | 288 | 993 | 0 |
| 4 processes | mailbox list | 32 / 128 | 50 / 373 | 468 / 191 | 2,176 / 1,241 | 0 |
| 4 processes | inbox page | 32 / 128 | 147-212 | 87 / 739 | 478 / 2,568 | 0 |
| 4 processes | search | 32 / 128 | 7 / 15 | 4,812 / 10,239 | 10,425 / 18,938 | 0 |

The single-process BFF ran first, while the host was a little quieter. The 4-process run then
collapsed as load rose again. This is not evidence that more processes are slower. The BFF is a
thin proxy, and Stalwart (Rust, multithreaded) does the real work in every scenario. The
mailboxes contained only about 100 messages each, so search figures for large mailboxes still
need to be measured.

## Findings from the code and the runs (these hold regardless of the host)

1. **Send quota check scans the month (scaling issue).** Every `POST /emails` and batch calls
   `quotaUsage()`: `count(*)` over the team's emails this month, plus `received_emails`
   (`apps/send/src/services/emails.ts`). The cost grows with monthly volume, so a team sending
   millions a month pays an index range scan on every send. `QUOTA_SCAN=1 ./send/run.sh`
   measures this at 100k, 500k and 1M rows. It has not been run on a quiet host yet. Fix: keep a
   per-team, per-day counter row and update it in the same transaction.
2. **Send worker runs jobs one at a time** (`drain()` does `for … await runJob`, 20 claimed per
   round), and webhook delivery is serial too. Throughput per worker process is therefore bound
   by latency, not CPU. In the bench, adding 3 webhook endpoints cut the email drain rate by
   about 90%, because the same serial loop also delivers the webhooks. Scale with
   `WORKER_CONCURRENCY` (SKIP LOCKED makes that safe), or add a small in-process concurrency pool.
3. **Rate limiters are in memory per process** (Send API and SMTP team limits, login limits in
   both apps). With N processes the effective limit is N times the configured value. This is
   documented by repo-builder, not fixed.
4. **Stalwart production defaults throttle single clients:** 1,000 authenticated HTTP requests
   per minute per account, 4 concurrent JMAP requests per account, 5 SMTP connections per second
   per IP, 25 messages per hour per sender domain and recipient, and 10 messages per SMTP
   session. These protect real users, but any load test from one IP hits them first. The bench
   lifts them (`stalwart/setup.sh`) and says so.
5. **Postgres connections:** the total pool size across every process must fit within
   `max_connections`. `deploy/docker-compose.yml` already sets `max_connections=200`. With the
   default pools (Send 5, webmail 4) and one worker and one smtp process, an 8-core box uses
   about 100 connections including Stalwart's 20. Running every role per core at pool 5 uses
   about 120, which still fits. Only a Postgres left at the stock limit of 100 would be tight.
   The bench sets 200.

## To do before citing numbers

- Run `README.md`'s loop on an idle host or on real 2 vCPU / 4 GB and 4 vCPU / 8 GB VMs with the
  load generator on a separate machine, and check that `calib` is stable across runs.
- Run `QUOTA_SCAN=1` (finding 1) and a search test against a large mailbox (raise `INGEST_TOTAL`).
- Raw data for every row above is in `results/` (JSON, logs, per-second container CPU in `stats-*.tsv`).
