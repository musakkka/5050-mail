---
title: Scaling
description: How 5050 Mail uses every core on one VM, when to grow the VM, and how to spread it across machines.
---

# Scaling

Most teams never need more than one VM. This page explains what grows with load and what to do about it.

## What one VM uses

Measured at rest on a 2 vCPU / 4 GB VM with `WEB_CONCURRENCY=auto`:

| Service | Memory | Note |
|---|---|---|
| Postgres | about 150 to 300 MB | `shared_buffers=256MB` |
| Stalwart (mail server) | about 150 to 400 MB | grows with its cache |
| webmail | about 60 to 90 MB per process | one per core |
| send-web, send-smtp | about 70 to 100 MB per process | one per core, and 1 |
| send-worker | about 80 MB | 1 process |
| Caddy | about 30 MB | |

That is about 1 to 1.5 GB in total, which leaves headroom on 4 GB.

## One VM uses all its cores

Node.js runs JavaScript on one core per process. So the webmail and 5050 Send's web role start **one process per CPU core** by default (`WEB_CONCURRENCY=auto`) and share the work between them. Moving from a 2 vCPU to an 8 vCPU VM speeds up the web tier without any configuration. Stalwart is written in Rust and multi-threaded on its own.

<!-- BENCH: replace with numbers from bench/RESULTS.md once it exists. Do not invent numbers. -->
Benchmarks comparing one process with one process per core will be published from the project's benchmark suite (`bench/` in the repository).

## Growing one VM

Resize the VM when you see one of these:

| Signal | Where to look | What helps |
|---|---|---|
| Disk filling | `df -h`, **Storage used** in the admin console | A bigger disk, or storage limits per user |
| CPU often near 100% | `top`, `docker stats` | More vCPU: the Node services pick up the new cores on restart |
| Memory pressure, swapping | `free -m`, `docker stats` | More RAM; Postgres and the mail server's cache use it well |
| Send queue growing | Send dashboard, **Emails** stuck in `queued` | Raise `SEND_WORKER_CONCURRENCY`; check delivery errors first |

After resizing, re-run the installer so every service sees the new core count:

```sh
sudo /opt/5050-mail/install.sh
```

Keep the total Postgres connections, roughly the number of processes times their pool size (`SEND_PG_POOL_MAX` for Send, 4 for the webmail), below Postgres's `max_connections` of 200.

## More send throughput

Raise `SEND_WORKER_CONCURRENCY` in `.env`. Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so two workers never process the same email, and periodic tasks run in one process only.

## More machines

Everything stateful lives in Postgres, so you can run more webmail and Send web containers on other hosts behind any load balancer, all pointed at the same database. Use a managed Postgres if you need high availability. Stalwart supports clustering on its own; see its documentation.

> [!NOTE]
> Login throttles and per-team API rate limits are kept in memory, so they apply per process. With N processes a team can reach about N times its configured rate.
