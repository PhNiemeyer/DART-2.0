#!/bin/sh
# Legt die Rollen des Identity Vault an (eigener Datenbankserver, eigene Zugangsdaten).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE vault_owner LOGIN PASSWORD '${VAULT_OWNER_PASSWORD}';
CREATE ROLE vault_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${VAULT_APP_PASSWORD}';
CREATE DATABASE dart_vault OWNER vault_owner;
REVOKE ALL ON DATABASE dart_vault FROM PUBLIC;
GRANT CONNECT ON DATABASE dart_vault TO vault_app;
SQL
