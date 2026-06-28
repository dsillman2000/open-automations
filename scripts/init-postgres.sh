#!/usr/bin/env bash
set -euo pipefail

CONTAINER="open-automations-dbos"
DB_USER="open"
DB_PASS="automations"
DB_NAME="open_automations"
SYS_DB_NAME="open_automations_dbos_sys"
PG_IMAGE="postgres:18"

down() {
  if docker container inspect "$CONTAINER" &>/dev/null; then
    echo "Stopping and removing container '$CONTAINER'..."
    docker stop "$CONTAINER" && docker rm "$CONTAINER"
  else
    echo "Container '$CONTAINER' does not exist."
  fi
}

up() {
  if docker container inspect "$CONTAINER" &>/dev/null; then
    echo "Container '$CONTAINER' already exists. Starting it..."
    docker start "$CONTAINER"
  else
    echo "Starting new Postgres 18 container '$CONTAINER'..."
    docker run -d \
      --name "$CONTAINER" \
      -e POSTGRES_USER="$DB_USER" \
      -e POSTGRES_PASSWORD="$DB_PASS" \
      -e POSTGRES_DB="$DB_NAME" \
      -p 5432:5432 \
      "$PG_IMAGE"
  fi

  echo "Waiting for Postgres to become ready..."
  for i in $(seq 1 30); do
    if docker exec "$CONTAINER" pg_isready -U "$DB_USER" &>/dev/null; then
      echo "Postgres is ready."
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "Timed out waiting for Postgres."
      exit 1
    fi
    sleep 1
  done

  echo "Database '$DB_NAME' is ready at postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME"

  echo "Creating system database '$SYS_DB_NAME'..."
  docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname='$SYS_DB_NAME'" | grep -q 1 \
    || docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c \
      "CREATE DATABASE $SYS_DB_NAME OWNER $DB_USER;"

  echo "All databases ready."
}

case "${1:-up}" in
  up)
    up
    ;;
  down)
    down
    ;;
  restart)
    down
    up
    ;;
  *)
    echo "Usage: $0 [up|down|restart]"
    exit 1
    ;;
esac
