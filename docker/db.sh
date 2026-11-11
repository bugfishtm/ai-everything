# Everything Studio — helpers for the built-in database (sourced by the
# entrypoint and by `studio-db`). Bash, runs as root inside the container.
#
#   data      /var/lib/mysql               (Docker volume)
#   socket    /run/mysqld/mysqld.sock      (no TCP port; every account needs its password —
#             the WordPress sites of users reach their own database through it)
#   app user  studio@localhost, password generated once and kept in the data
#             volume (root only): $DATA_DIR/home/.studio/db-password

DB_DATA=/var/lib/mysql
DB_SOCKET=/run/mysqld/mysqld.sock
DB_STATE_DIR="${DATA_DIR:-/data}/home/.studio"
DB_PW_FILE="$DB_STATE_DIR/db-password"
DB_NAME="${MYSQL_DATABASE:-studio}"
DB_USER="${MYSQL_USER:-studio}"
DB_PID=""

db_log() { echo "[db] $*" >&2; }

db_external() { [ -n "${MYSQL_HOST:-}" ]; }

db_running() { mariadb-admin --socket="$DB_SOCKET" --connect-timeout=2 ping >/dev/null 2>&1; }

# Start MariaDB in the background (initialises an empty data volume first).
db_start() {
  # traversable: the PHP of a WordPress site (a sandbox user) connects to the socket with the
  # site's own account; root is only accepted from the root user (socket authentication)
  install -d -o mysql -g mysql -m 0755 /run/mysqld
  mkdir -p "$DB_DATA"
  chown mysql:mysql "$DB_DATA"
  chmod 0750 "$DB_DATA"
  if [ ! -d "$DB_DATA/mysql" ]; then
    db_log "first start: initialising the database in $DB_DATA"
    mariadb-install-db --user=mysql --datadir="$DB_DATA" \
      --auth-root-authentication-method=socket --skip-test-db >/dev/null
  fi
  mariadbd --user=mysql &
  DB_PID=$!
  local i
  for i in $(seq 1 240); do
    if db_running; then
      db_ensure_app_user
      return 0
    fi
    if ! kill -0 "$DB_PID" 2>/dev/null; then
      db_log "the database did not start — see the messages above"
      return 1
    fi
    sleep 0.5
  done
  db_log "the database did not answer within 2 minutes"
  return 1
}

# Database + application account; the password survives in the data volume and
# is re-applied on every start (so either volume can be restored on its own).
db_ensure_app_user() {
  install -d -m 0700 "$DB_STATE_DIR"
  if [ ! -s "$DB_PW_FILE" ]; then
    (umask 077 && head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40 >"$DB_PW_FILE")
  fi
  chmod 0600 "$DB_PW_FILE"
  local pw
  pw="$(cat "$DB_PW_FILE")"
  mariadb --socket="$DB_SOCKET" -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$pw';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$pw';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
DELETE FROM mysql.global_priv WHERE User = '';
FLUSH PRIVILEGES;
SQL
}

# Environment for the Studio server (password via file, not via the environment).
db_export_env() {
  export MYSQL_SOCKET="$DB_SOCKET" MYSQL_PASSWORD_FILE="$DB_PW_FILE" MYSQL_USER="$DB_USER" MYSQL_DATABASE="$DB_NAME"
  unset MYSQL_PASSWORD MYSQL_HOST
}

db_stop() {
  if db_running; then
    mariadb-admin --socket="$DB_SOCKET" shutdown >/dev/null 2>&1 || true
  fi
  if [ -n "$DB_PID" ]; then
    wait "$DB_PID" 2>/dev/null || true
    DB_PID=""
  fi
}
