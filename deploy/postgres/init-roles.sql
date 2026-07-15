\getenv migration_password POSTGRES_MIGRATION_PASSWORD
\getenv runtime_password POSTGRES_RUNTIME_PASSWORD
\getenv maintenance_password POSTGRES_MAINTENANCE_PASSWORD

\if :{?migration_password}
\else
  \echo 'POSTGRES_MIGRATION_PASSWORD is required'
  \quit
\endif

\if :{?runtime_password}
\else
  \echo 'POSTGRES_RUNTIME_PASSWORD is required'
  \quit
\endif

\if :{?maintenance_password}
\else
  \echo 'POSTGRES_MAINTENANCE_PASSWORD is required'
  \quit
\endif

CREATE ROLE wx_migrate
  LOGIN
  PASSWORD :'migration_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT;

CREATE ROLE wx_runtime
  LOGIN
  PASSWORD :'runtime_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT;

CREATE ROLE wx_maintenance
  LOGIN
  PASSWORD :'maintenance_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT;

CREATE DATABASE wx_upload OWNER wx_migrate;

REVOKE ALL ON DATABASE wx_upload FROM PUBLIC;
GRANT CONNECT ON DATABASE wx_upload TO wx_runtime, wx_maintenance;
