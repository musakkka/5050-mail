---
title: Backups and upgrades
description: What to back up, how to restore, and how install.sh upgrades and uninstalls 5050 Mail.
---

# Backups and upgrades

The commands below use the stack's compose file. To save typing, add this alias to root's shell:

```sh
alias dc='docker compose --env-file /opt/5050-mail/.env -f /opt/5050-mail/deploy/docker-compose.yml'
```

## What holds your data

| What | Where | Back it up |
|---|---|---|
| Configuration and every secret | `/opt/5050-mail/.env` | yes, once and after every change |
| Mail, attachments, accounts, sessions, Send data | Postgres (`postgres-data` volume): databases `stalwart`, `send`, `webmail` | yes, daily |
| Mail server state | `stalwart-data` and `stalwart-etc` volumes | yes |
| TLS certificates | `caddy-data` volume | optional (they are re-issued) |

Keep copies **off the server**. A backup on the same disk doesn't survive the disk.

## Backing up

A consistent dump of every database, compressed:

```sh
sudo docker compose --env-file /opt/5050-mail/.env -f /opt/5050-mail/deploy/docker-compose.yml \
  exec -T postgres pg_dumpall -U postgres | gzip > /root/5050-mail-$(date +%F).sql.gz
```

Then copy the dump and `.env` to another machine or to object storage, for example with `rsync`, `restic` or `rclone`. Schedule it with cron:

```sh title="/etc/cron.d/5050-mail-backup"
15 3 * * * root docker compose --env-file /opt/5050-mail/.env -f /opt/5050-mail/deploy/docker-compose.yml exec -T postgres pg_dumpall -U postgres | gzip > /var/backups/5050-mail-$(date +\%F).sql.gz
```

Your VM provider's disk snapshots are a good second layer, not a replacement: they usually live with the same provider.

## Restoring

On a fresh VM:

1. Copy your `.env` to `/opt/5050-mail/.env`.
2. Run the installer. It keeps the existing `.env`, so the secrets match the backup.
3. Stop everything except Postgres, restore the dump, then start the stack again:

```sh
dc stop webmail send-web send-worker send-smtp stalwart caddy
gunzip -c 5050-mail-2026-10-22.sql.gz | dc exec -T postgres psql -U postgres
sudo /opt/5050-mail/install.sh
```

4. If the IP address changed, update the `A` records of the mail, send and api hostnames, and the PTR.

## Upgrading

```sh
sudo /opt/5050-mail/install.sh --upgrade
```

`--upgrade` updates the source from GitHub, rebuilds the images and restarts the stack. Database migrations run on start. It keeps `.env` and all data. Take a backup first.

Re-running the installer without flags is also safe: it reconciles the configuration without updating the source.

## Uninstalling

```sh
sudo /opt/5050-mail/install.sh --uninstall           # remove containers; keep data volumes and .env
sudo /opt/5050-mail/install.sh --uninstall --purge   # delete everything, including all mail
```

`--purge` asks for confirmation and cannot be undone.
