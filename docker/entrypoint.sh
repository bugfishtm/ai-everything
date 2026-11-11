#!/bin/bash
# Everything Studio — container entry point (one container, two processes).
#
#   docker run … everything-studio          built-in database + Studio server
#   docker run … everything-studio bash     any other command (nothing is started)
#
# The built-in database is MariaDB (data in the /var/lib/mysql volume, reachable
# only through its Unix socket). Set MYSQL_HOST (+ MYSQL_USER, MYSQL_PASSWORD,
# MYSQL_DATABASE) to use an external MySQL/MariaDB server instead.
set -uo pipefail

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# shellcheck source=docker/db.sh
. /usr/local/lib/studio/db.sh

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR/projects" "$DATA_DIR/library" "$DATA_DIR/home" "$DATA_DIR/packs" "$DATA_DIR/sdk"

APP_PID=""
stopping=0

shutdown() {
  stopping=1
  echo "[entrypoint] stopping …"
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null
    wait "$APP_PID" 2>/dev/null
  fi
  db_external || db_stop
  echo "[entrypoint] stopped"
  exit 0
}
trap shutdown TERM INT

if db_external; then
  echo "[entrypoint] using the external database at ${MYSQL_HOST}"
else
  db_start || exit 1
  db_export_env
fi

cd /opt/studio/server || exit 1
node dist/index.js &
APP_PID=$!

# Wait until one of the two ends on its own, then stop the other (the restart
# policy brings the container back).
if [ -n "$DB_PID" ]; then
  wait -n "$APP_PID" "$DB_PID"
else
  wait "$APP_PID"
fi
code=$?
[ "$stopping" = 1 ] && exit 0
if kill -0 "$APP_PID" 2>/dev/null; then
  echo "[entrypoint] the database stopped unexpectedly (exit $code) — stopping the Studio"
  kill -TERM "$APP_PID" 2>/dev/null
  wait "$APP_PID" 2>/dev/null
else
  echo "[entrypoint] the Studio server stopped (exit $code)"
  db_external || db_stop
fi
exit $(( code == 0 ? 1 : code ))
