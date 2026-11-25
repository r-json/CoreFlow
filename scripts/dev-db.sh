#!/usr/bin/env bash
#
# Local development PostgreSQL for CoreFlow.
#
# Creates a PRIVATE PostgreSQL cluster owned by the current user, in the current
# user's home directory, on a NON-DEFAULT port. It does not touch the system
# PostgreSQL instance, does not need root, and does not circumvent any
# authentication: the cluster is created by you, so you are legitimately its
# superuser.
#
# Why a separate cluster rather than a database in the system one: creating a role
# there needs an existing superuser, and on this machine neither `postgres` peer
# authentication nor the old `coreflow` password is available. Standing up an
# unprivileged cluster is the safe way through that, and it has a side benefit —
# development cannot reach anything but its own data.
#
# This is DEVELOPMENT ONLY. It is never production, never staging, never shared.
#
#   ./scripts/dev-db.sh init     create the cluster, databases and .env.local URLs
#   ./scripts/dev-db.sh start    start it
#   ./scripts/dev-db.sh stop     stop it
#   ./scripts/dev-db.sh status   is it running?
#   ./scripts/dev-db.sh psql     open a shell on coreflow_dev
#   ./scripts/dev-db.sh destroy  delete the cluster and all its data
#
set -euo pipefail

PGDATA="${COREFLOW_PGDATA:-$HOME/.local/share/coreflow/pgdata}"
PGPORT="${COREFLOW_PGPORT:-5440}"
PGUSER_DEV="coreflow"
DB_DEV="coreflow_dev"
# Prisma RESETS the shadow database. It must never be anything you want to keep,
# which is why it is a separate database rather than a schema in the dev one.
DB_SHADOW="coreflow_shadow"
LOGFILE="$PGDATA/../postgres.log"
ENV_FILE=".env"

die() { echo "error: $*" >&2; exit 1; }

running() { pg_ctl -D "$PGDATA" status >/dev/null 2>&1; }

cmd_init() {
  [ -d "$PGDATA" ] && die "$PGDATA already exists. Use 'start', or 'destroy' first."
  command -v initdb >/dev/null || die "initdb not found."

  mkdir -p "$(dirname "$PGDATA")"

  # Generated locally, never echoed, never committed. The pwfile is removed
  # immediately after initdb consumes it.
  local pwfile
  pwfile="$(mktemp)"
  chmod 600 "$pwfile"
  node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))" > "$pwfile"

  echo "Creating cluster at $PGDATA ..."
  initdb -D "$PGDATA" \
    --username="$PGUSER_DEV" \
    --auth-local=scram-sha-256 \
    --auth-host=scram-sha-256 \
    --pwfile="$pwfile" \
    --encoding=UTF8 \
    --no-instructions >/dev/null

  # Listen on loopback only. A development database must not be reachable from the
  # network, whatever else is misconfigured.
  {
    echo "port = $PGPORT"
    echo "listen_addresses = '127.0.0.1'"
    echo "unix_socket_directories = '$PGDATA'"
    # Small: this is one developer's machine, not a server.
    echo "max_connections = 50"
    echo "shared_buffers = 128MB"
    echo "fsync = off"                  # development only; speeds up test resets
    echo "full_page_writes = off"       # development only
  } >> "$PGDATA/postgresql.conf"

  cmd_start

  local password url_dev url_shadow
  password="$(cat "$pwfile")"
  rm -f "$pwfile"

  PGPASSWORD="$password" createdb -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER_DEV" "$DB_DEV"
  PGPASSWORD="$password" createdb -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER_DEV" "$DB_SHADOW"
  echo "Created databases $DB_DEV and $DB_SHADOW."

  url_dev="postgresql://$PGUSER_DEV:$password@127.0.0.1:$PGPORT/$DB_DEV?schema=public"
  url_shadow="postgresql://$PGUSER_DEV:$password@127.0.0.1:$PGPORT/$DB_SHADOW?schema=public"

  [ -f "$ENV_FILE" ] || touch "$ENV_FILE"
  # Rewrite only the database keys; every other line, including every secret, is
  # left exactly as it was. PRISMA_DATABASE_URL and POSTGRES_URL are deployment
  # artifacts a `vercel env pull` leaves behind — they are commented out rather
  # than deleted, so nothing is silently lost.
  python3 - "$ENV_FILE" "$url_dev" "$url_shadow" <<'PYEOF'
import re, sys
path, url_dev, url_shadow = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    lines = f.read().splitlines()

targets = {'DATABASE_URL': url_dev, 'DIRECT_URL': url_dev, 'SHADOW_DATABASE_URL': url_shadow}
neutralize = {'PRISMA_DATABASE_URL', 'POSTGRES_URL'}
out, seen = [], set()
for line in lines:
    m = re.match(r'^([A-Z_][A-Z0-9_]*)=', line)
    key = m.group(1) if m else None
    if key in targets:
        out.append('%s="%s"' % (key, targets[key]))
        seen.add(key)
    elif key in neutralize:
        out.append('# Deployment artifact from `vercel env pull`; not used locally.')
        out.append('# ' + line)
    else:
        out.append(line)
for key, url in targets.items():
    if key not in seen:
        out.append('%s="%s"' % (key, url))
with open(path, 'w') as f:
    f.write('\n'.join(out) + '\n')
print('Wrote DATABASE_URL, DIRECT_URL and SHADOW_DATABASE_URL to ' + path)
PYEOF

  echo
  echo "Done. The password was generated locally and written only to $ENV_FILE"
  echo "(git-ignored). It was not printed."
  echo
  echo "Next:  npm run check:env  &&  npm run db:deploy"
}

cmd_start() {
  [ -d "$PGDATA" ] || die "no cluster at $PGDATA. Run 'init' first."
  if running; then echo "Already running on port $PGPORT."; return; fi
  pg_ctl -D "$PGDATA" -l "$LOGFILE" start >/dev/null
  for _ in $(seq 1 30); do
    running && break
    sleep 0.2
  done
  running || die "failed to start; see $LOGFILE"
  echo "PostgreSQL running on 127.0.0.1:$PGPORT (data: $PGDATA)"
}

cmd_stop() {
  running || { echo "Not running."; return; }
  pg_ctl -D "$PGDATA" stop -m fast >/dev/null
  echo "Stopped."
}

cmd_status() {
  if running; then
    echo "running on 127.0.0.1:$PGPORT"
    pg_ctl -D "$PGDATA" status | head -2
  else
    echo "not running (data: $PGDATA)"
  fi
}

cmd_psql() {
  running || die "not running. Run 'start' first."
  # Reads the URL from .env.local so the password never appears in a command.
  local url
  url="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | sed 's/^DATABASE_URL=//' | tr -d '"')"
  [ -n "$url" ] || die "no DATABASE_URL in $ENV_FILE"
  psql "$url"
}

cmd_destroy() {
  running && pg_ctl -D "$PGDATA" stop -m immediate >/dev/null || true
  [ -d "$PGDATA" ] || { echo "Nothing to remove."; return; }
  rm -rf "$PGDATA" "$LOGFILE"
  echo "Removed $PGDATA. Database keys in $ENV_FILE now point at nothing."
}

case "${1:-}" in
  init) cmd_init ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  psql) cmd_psql ;;
  destroy) cmd_destroy ;;
  *) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
