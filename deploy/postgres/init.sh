#!/bin/sh
# First start of the Postgres volume only: one role + database per service.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE stalwart LOGIN PASSWORD '${STALWART_DB_PASSWORD}';
CREATE DATABASE stalwart OWNER stalwart;
CREATE ROLE send LOGIN PASSWORD '${SEND_DB_PASSWORD}';
CREATE DATABASE send OWNER send;
CREATE ROLE webmail LOGIN PASSWORD '${WEBMAIL_DB_PASSWORD}';
CREATE DATABASE webmail OWNER webmail;
SQL
