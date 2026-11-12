set -eu
deploy_sha="${1:?missing-deploy-sha}"
case "$deploy_sha" in
  ''|*[!0-9a-f]*) echo "Invalid deployment SHA" >&2; exit 1 ;;
esac
test "${#deploy_sha}" -eq 40
staging_dir="/tmp/guaro-deploy-${deploy_sha}"
bundle_name="guaro-images-${deploy_sha}.tar.gz"
bundle_file="${staging_dir}/${bundle_name}"
digest_file="${bundle_file}.sha256"
backup_tmp=""
rollback_armed=false
services_switched=false
previous_checkout=""
previous_backend_image=""
previous_frontend_image=""
previous_promo_image=""
previous_promo_container=""
backend_rollback_tag='guaro-backend:rollback-previous'
frontend_rollback_tag='guaro-frontend:rollback-previous'
promo_rollback_tag='guaro-promo-manager:rollback-previous'
aux_services_started=false
promo_only=false
paused_queues=""
caddy_config='/root/grocerytools/grocerytools/Caddyfile'
caddy_backup=''
caddy_on_standby=false
caddy_reload_attempted=false
standby_backend_started=false
standby_frontend_started=false

cleanup_artifacts() {
  if [ -n "$backup_tmp" ]; then
    rm -f -- "$backup_tmp"
  fi
  rm -f -- "$bundle_file" "$digest_file"
  rmdir -- "$staging_dir" 2>/dev/null || true
}

wait_for_backend() {
  attempts="${1:-24}"
  for attempt in $(seq 1 "$attempts"); do
    if docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T backend \
      node -e "fetch('http://127.0.0.1:3000/auth/me', { signal: AbortSignal.timeout(5000) }).then(r => process.exit(r.status === 401 ? 0 : 1)).catch(() => process.exit(1))"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

wait_for_frontend() {
  attempts="${1:-24}"
  for attempt in $(seq 1 "$attempts"); do
    if docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T frontend \
      sh -ec 'pidof nginx >/dev/null; body="$(wget -q -T 5 -O - http://127.0.0.1/)"; test -n "$body"'; then
      return 0
    fi
    sleep 5
  done
  return 1
}

wait_for_promo() {
  attempts="${1:-24}"
  for attempt in $(seq 1 "$attempts"); do
    if docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T promo-manager \
      node -e "Promise.all([fetch('http://127.0.0.1:5373/api/health', { signal: AbortSignal.timeout(5000) }), fetch('http://127.0.0.1:5373/api/config', { signal: AbortSignal.timeout(30000) })]).then(async ([health, config]) => { const data = await config.json(); process.exit(health.ok && config.ok && Array.isArray(data.stores) && data.stores.length > 0 ? 0 : 1); }).catch(() => process.exit(1))"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

wait_for_neto_worker() {
  attempts="${1:-24}"
  for attempt in $(seq 1 "$attempts"); do
    container="$(docker compose -f docker-compose.prod.yml --env-file .env.prod ps -q neto-worker)"
    if [ -n "$container" ] && [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" = "healthy" ]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

start_standby_routes() {
  test -f "$caddy_config"
  test -z "$(docker ps -a --filter name='^/guaro-backend-standby$' --format '{{.Names}}')"
  test -z "$(docker ps -a --filter name='^/guaro-frontend-standby$' --format '{{.Names}}')"
  test "$(grep -o 'guaro-backend-1:3000' "$caddy_config" | wc -l)" -ge 1
  test "$(grep -o 'guaro-frontend-1:80' "$caddy_config" | wc -l)" -ge 1

  docker compose -f docker-compose.prod.yml --env-file .env.prod run -d \
    --no-deps --name guaro-backend-standby \
    -e SCHEDULED_JOBS_ENABLED=false -e TASK_DEADLINES_ENABLED=false backend
  standby_backend_started=true
  for attempt in $(seq 1 24); do
    if docker exec guaro-backend-standby node -e \
      "fetch('http://127.0.0.1:3000/auth/me', { signal: AbortSignal.timeout(5000) }).then(r => process.exit(r.status === 401 ? 0 : 1)).catch(() => process.exit(1))"; then
      break
    fi
    test "$attempt" -lt 24
    sleep 5
  done

  docker compose -f docker-compose.prod.yml --env-file .env.prod run -d \
    --no-deps --name guaro-frontend-standby frontend
  standby_frontend_started=true
  for attempt in $(seq 1 24); do
    if docker exec grocerytools-caddy-1 wget -q -T 5 -O /dev/null \
      http://guaro-frontend-standby/; then
      break
    fi
    test "$attempt" -lt 24
    sleep 5
  done

  caddy_backup="$(mktemp /tmp/guaro-caddy-${deploy_sha}.XXXXXX)"
  cp -p -- "$caddy_config" "$caddy_backup"
  caddy_next="$(mktemp /tmp/guaro-caddy-next-${deploy_sha}.XXXXXX)"
  sed -e 's/guaro-backend-1:3000/guaro-backend-standby:3000/g' \
      -e 's/guaro-frontend-1:80/guaro-frontend-standby:80/g' \
      "$caddy_backup" > "$caddy_next"
  cp -- "$caddy_next" "$caddy_config"
  rm -f -- "$caddy_next"
  docker exec grocerytools-caddy-1 caddy validate --config /etc/caddy/Caddyfile
  caddy_reload_attempted=true
  docker exec grocerytools-caddy-1 caddy reload --config /etc/caddy/Caddyfile
  caddy_on_standby=true
  echo 'Guaro traffic is on healthy standby containers during the service switch'
}

restore_primary_routes() {
  if [ -z "$caddy_backup" ]; then
    return 0
  fi
  cp -- "$caddy_backup" "$caddy_config"
  docker exec grocerytools-caddy-1 caddy validate --config /etc/caddy/Caddyfile
  docker exec grocerytools-caddy-1 caddy reload --config /etc/caddy/Caddyfile
  caddy_on_standby=false
  return 0
}

stop_standby() {
  if [ "$standby_frontend_started" = "true" ]; then
    docker stop -t 30 guaro-frontend-standby >/dev/null
    docker rm guaro-frontend-standby >/dev/null
    standby_frontend_started=false
  fi
  if [ "$standby_backend_started" = "true" ]; then
    docker stop -t 240 guaro-backend-standby >/dev/null
    docker rm guaro-backend-standby >/dev/null
    standby_backend_started=false
  fi
  if [ -n "$caddy_backup" ]; then
    rm -f -- "$caddy_backup"
    caddy_backup=''
  fi
}

resume_background_queues() {
  if [ -z "$paused_queues" ]; then
    return 0
  fi
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T \
    -e "GUARO_QUEUES=$paused_queues" backend node -e '
      const { Queue } = require("bullmq");
      (async () => {
        for (const name of process.env.GUARO_QUEUES.split(" ").filter(Boolean)) {
          const queue = new Queue(name, { connection: { host: "guaro-redis", port: 6379 } });
          try { await queue.resume(); console.log(name, "resumed"); }
          finally { await queue.close(); }
        }
      })().catch(error => { console.error(error); process.exit(1); });'
  paused_queues=""
}

rollback_deployment() {
  rollback_failed=0
  echo "Deployment failed; restoring the previous checkout and service images" >&2

  if [ "$aux_services_started" = "true" ]; then
    if [ "$promo_only" = "true" ]; then
      docker compose -f docker-compose.prod.yml --env-file .env.prod stop promo-manager || rollback_failed=1
      docker compose -f docker-compose.prod.yml --env-file .env.prod rm -f promo-manager || rollback_failed=1
    else
      docker compose -f docker-compose.prod.yml --env-file .env.prod stop promo-manager neto-worker || rollback_failed=1
      docker compose -f docker-compose.prod.yml --env-file .env.prod rm -f promo-manager neto-worker || rollback_failed=1
    fi
  fi

  if ! docker tag "$previous_backend_image" guaro-backend:latest; then
    echo "Rollback error: could not restore backend latest tag" >&2
    rollback_failed=1
  fi
  if ! docker tag "$previous_frontend_image" guaro-frontend:latest; then
    echo "Rollback error: could not restore frontend latest tag" >&2
    rollback_failed=1
  fi
  if [ -n "$previous_promo_image" ]; then
    if ! docker tag "$previous_promo_image" guaro-promo-manager:latest; then
      echo "Rollback error: could not restore promo-manager latest tag" >&2
      rollback_failed=1
    fi
  fi
  if [ "$(docker image inspect guaro-backend:latest --format '{{.Id}}' 2>/dev/null)" != "$previous_backend_image" ]; then
    echo "Rollback error: backend latest tag does not match the previous image" >&2
    rollback_failed=1
  fi
  if [ "$(docker image inspect guaro-frontend:latest --format '{{.Id}}' 2>/dev/null)" != "$previous_frontend_image" ]; then
    echo "Rollback error: frontend latest tag does not match the previous image" >&2
    rollback_failed=1
  fi
  if ! git checkout --detach "$previous_checkout"; then
    echo "Rollback error: could not restore checkout ${previous_checkout}" >&2
    rollback_failed=1
  elif [ "$(git rev-parse HEAD 2>/dev/null)" != "$previous_checkout" ]; then
    echo "Rollback error: restored checkout does not match ${previous_checkout}" >&2
    rollback_failed=1
  fi

  if [ "$services_switched" = "true" ]; then
    if ! docker compose -f docker-compose.prod.yml --env-file .env.prod up -d \
      --no-build --no-deps --force-recreate backend frontend; then
      echo "Rollback error: could not recreate the previous services" >&2
      rollback_failed=1
    else
      if ! wait_for_backend 24; then
        echo "Rollback error: previous backend did not become ready" >&2
        docker compose -f docker-compose.prod.yml --env-file .env.prod logs --tail=120 backend >&2
        rollback_failed=1
      fi
      if ! wait_for_frontend 24; then
        echo "Rollback error: previous frontend did not become ready" >&2
        docker compose -f docker-compose.prod.yml --env-file .env.prod logs --tail=120 frontend >&2
        rollback_failed=1
      fi
    fi
  fi

  if [ "$aux_services_started" = "true" ] && [ -n "$previous_promo_container" ]; then
    if [ "$promo_only" = "true" ]; then
      aux_restore_services="promo-manager"
    else
      aux_restore_services="promo-manager neto-worker"
    fi
    if ! docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --no-build --no-deps $aux_restore_services; then
      echo "Rollback error: could not recreate the previous auxiliary services" >&2
      rollback_failed=1
    fi
  fi

  resume_background_queues || rollback_failed=1

  if [ "$rollback_failed" -eq 0 ]; then
    echo "Rollback completed successfully" >&2
  else
    echo "CRITICAL: automatic rollback was incomplete; manual intervention is required" >&2
  fi
  return "$rollback_failed"
}

on_exit() {
  original_status=$?
  trap - EXIT
  set +e
  rollback_failed=0
  if [ "$original_status" -ne 0 ] && [ "$rollback_armed" = "true" ]; then
    rollback_deployment || rollback_failed=1
  fi
  if [ "$rollback_failed" -eq 0 ] && [ -n "$caddy_backup" ]; then
    if restore_primary_routes; then
      if [ "$caddy_reload_attempted" = "true" ]; then
        sleep 220
      fi
      stop_standby || true
    else
      echo 'CRITICAL: standby routes could not be restored; standby containers remain online' >&2
    fi
  elif [ "$rollback_failed" -eq 0 ]; then
    stop_standby || true
  fi
  resume_background_queues || true
  cleanup_artifacts
  exit "$original_status"
}
trap on_exit EXIT

test -d "$staging_dir"
test ! -L "$staging_dir"
test -f "$bundle_file"
test ! -L "$bundle_file"
test -f "$digest_file"
test ! -L "$digest_file"
test "$(find "$staging_dir" -mindepth 1 -maxdepth 1 | wc -l)" -eq 2
(
  cd "$staging_dir"
  sha256sum -c "${bundle_name}.sha256"
)
gzip -t "$bundle_file"

exec 9>/tmp/guaro-production-deploy.lock
flock -w 300 9
app_dir=""
for candidate in /opt/guaro /root/Guaro /root/guaro /root/Guaro-1 /home/ubuntu/Guaro /home/ubuntu/guaro; do
  if [ -d "$candidate/.git" ] && [ -f "$candidate/docker-compose.prod.yml" ]; then
    app_dir="$candidate"
    break
  fi
done
if [ -z "$app_dir" ]; then
  compose_file="$(find /opt /root /home -maxdepth 5 -type f -name docker-compose.prod.yml -print -quit 2>/dev/null || true)"
  app_dir="${compose_file%/docker-compose.prod.yml}"
fi
test -n "$app_dir"
test -d "$app_dir/.git"
cd "$app_dir"

export COMPOSE_PROJECT_NAME=guaro
compose_images="$(docker compose -f docker-compose.prod.yml --env-file .env.prod config --images)"
printf '%s\n' "$compose_images" | grep -Fxq 'guaro-backend'
printf '%s\n' "$compose_images" | grep -Fxq 'guaro-frontend'

test -z "$(git status --porcelain --untracked-files=no)"
git fetch --prune origin main
git cat-file -e "${deploy_sha}^{commit}"
current_main_sha="$(git rev-parse FETCH_HEAD)"
if [ "$current_main_sha" != "$deploy_sha" ]; then
  echo "Refusing stale deployment: tested ${deploy_sha}, current main ${current_main_sha}" >&2
  exit 1
fi

disk_used_percent="$(df -P "$app_dir" | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
if [ "${disk_used_percent:-0}" -ge 80 ]; then
  echo "Disk usage is ${disk_used_percent}%; pruning unused Docker artifacts before deployment"
  docker builder prune -af
  docker image prune -af
fi
schema_changes="$(git diff --name-only HEAD "$deploy_sha" -- prisma/schema.prisma prisma/migrations prisma/deploy)"
if [ -n "$schema_changes" ]; then
  umask 077
  mkdir -p backups
  find backups -maxdepth 1 -type f -name 'pre-deploy-*.dump' -printf '%T@ %p\n' \
    | sort -nr \
    | tail -n +5 \
    | cut -d' ' -f2- \
    | xargs -r rm -f --
  backup_stamp="$(date +%Y%m%d-%H%M%S)"
  backup_file="backups/pre-deploy-${backup_stamp}.dump"
  backup_tmp="backups/.pre-deploy-${backup_stamp}.dump.tmp"
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T guaro-db \
    sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" -Fc' > "$backup_tmp"
  test -s "$backup_tmp"
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T guaro-db \
    pg_restore -l < "$backup_tmp" >/dev/null
  mv -- "$backup_tmp" "$backup_file"
  backup_tmp=""
  find backups -maxdepth 1 -type f -name 'pre-deploy-*.dump' -printf '%T@ %p\n' \
    | sort -nr \
    | tail -n +6 \
    | cut -d' ' -f2- \
    | xargs -r rm -f --
else
  echo "No Prisma schema or migration changes; retaining the existing backup"
fi

previous_checkout="$(git rev-parse HEAD)"
git cat-file -e "${previous_checkout}^{commit}"
release_changes="$(git diff --name-only "$previous_checkout" "$deploy_sha")"
non_promo_changes="$(printf '%s\n' "$release_changes" | grep -Ev '^(promo-manager/|\.github/workflows/deploy\.yml$)' || true)"
if [ -n "$release_changes" ] && [ -z "$non_promo_changes" ]; then
  promo_only=true
fi
previous_backend_container="$(docker compose -f docker-compose.prod.yml --env-file .env.prod ps -q backend)"
previous_frontend_container="$(docker compose -f docker-compose.prod.yml --env-file .env.prod ps -q frontend)"
test -n "$previous_backend_container"
test -n "$previous_frontend_container"
test "$(docker inspect --format '{{.State.Running}}' "$previous_backend_container")" = "true"
test "$(docker inspect --format '{{.State.Running}}' "$previous_frontend_container")" = "true"
previous_backend_image="$(docker inspect --format '{{.Image}}' "$previous_backend_container")"
previous_frontend_image="$(docker inspect --format '{{.Image}}' "$previous_frontend_container")"
previous_promo_container="$(docker compose -f docker-compose.prod.yml --env-file .env.prod ps -q promo-manager 2>/dev/null || true)"
if [ -n "$previous_promo_container" ]; then
  previous_promo_image="$(docker inspect --format '{{.Image}}' "$previous_promo_container")"
  docker image inspect "$previous_promo_image" >/dev/null
  docker tag "$previous_promo_image" "$promo_rollback_tag"
fi
docker image inspect "$previous_backend_image" >/dev/null
docker image inspect "$previous_frontend_image" >/dev/null
docker tag "$previous_backend_image" "$backend_rollback_tag"
docker tag "$previous_frontend_image" "$frontend_rollback_tag"
rollback_armed=true

if [ "$promo_only" != "true" ]; then
  start_standby_routes
fi

git checkout --detach "$deploy_sha"
test "$(git rev-parse HEAD)" = "$deploy_sha"
compose_images="$(docker compose -f docker-compose.prod.yml --env-file .env.prod config --images)"
printf '%s\n' "$compose_images" | grep -Fxq 'guaro-backend'
printf '%s\n' "$compose_images" | grep -Fxq 'guaro-frontend'
printf '%s\n' "$compose_images" | grep -Fxq 'guaro-promo-manager:latest'

gzip -dc "$bundle_file" | docker load
test "$(docker image inspect guaro-backend:latest --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$deploy_sha"
test "$(docker image inspect guaro-frontend:latest --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$deploy_sha"
test "$(docker image inspect guaro-promo-manager:latest --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$deploy_sha"

if [ "$promo_only" = "true" ]; then
  aux_services_started=true
  docker compose -f docker-compose.prod.yml --env-file .env.prod up -d \
    --no-build --no-deps promo-manager
  if ! wait_for_promo 24; then
    docker compose -f docker-compose.prod.yml --env-file .env.prod logs --tail=120 promo-manager
    exit 1
  fi
  rollback_armed=false
  docker compose -f docker-compose.prod.yml --env-file .env.prod ps
  exit 0
fi

failed_filter_migration="$(
  printf '%s\n' \
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '20261015005000_didi_order_webhook_filter_indexes' AND finished_at IS NULL AND rolled_back_at IS NULL;" \
    | docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T guaro-db \
        sh -c 'psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
)"
if [ "$failed_filter_migration" -gt 0 ]; then
  docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps backend \
    npx prisma migrate resolve --rolled-back 20261015005000_didi_order_webhook_filter_indexes \
      --schema=./prisma/schema.prisma
fi
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T guaro-db \
  sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < prisma/migrations/20261016020000_didi_order_webhook_financials/migration.sql
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T \
  -e PGOPTIONS='-c max_parallel_maintenance_workers=0' guaro-db \
  sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < prisma/deploy/didi_order_webhook_indexes_online.sql
payload_resolution_ready="$(
  printf '%s\n' \
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.didi_order_webhook_event') AND attname = 'shop_resolution_source' AND NOT attisdropped) THEN 1 ELSE 0 END;" \
    | docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T guaro-db \
        sh -c 'psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
)"
if [ "$payload_resolution_ready" -eq 1 ]; then
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T guaro-db \
    sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    < prisma/migrations/20261016023000_didi_order_webhook_payload_resolution_check/migration.sql
fi
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps backend \
  npx prisma migrate deploy --schema=./prisma/schema.prisma
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T \
  -e PGOPTIONS='-c max_parallel_maintenance_workers=0' guaro-db \
  sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < prisma/deploy/task_sla_indexes_online.sql
aux_services_started=true
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d \
  --no-build --no-deps promo-manager neto-worker
if ! wait_for_promo 24; then
  docker compose -f docker-compose.prod.yml --env-file .env.prod logs --tail=120 promo-manager
  exit 1
fi
if ! wait_for_neto_worker 24; then
  docker compose -f docker-compose.prod.yml --env-file .env.prod logs --tail=120 neto-worker
  exit 1
fi
paused_queues="$(docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T backend node -e '
  const { Queue } = require("bullmq");
  const names = ["auto-fetch", "auto-turn-off-MX", "auto-turn-off-CO", "auto-turn-off-CR", "auto-turn-off-shop"];
  (async () => {
    const running = [];
    for (const name of names) {
      const queue = new Queue(name, { connection: { host: "guaro-redis", port: 6379 } });
      try { if (!(await queue.isPaused())) running.push(name); }
      finally { await queue.close(); }
    }
    console.log(running.join(" "));
  })().catch(error => { console.error(error); process.exit(1); });')"
if [ -n "$paused_queues" ]; then
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T \
    -e "GUARO_QUEUES=$paused_queues" backend node -e '
      const { Queue } = require("bullmq");
      (async () => {
        for (const name of process.env.GUARO_QUEUES.split(" ").filter(Boolean)) {
          const queue = new Queue(name, { connection: { host: "guaro-redis", port: 6379 } });
          try { await queue.pause(); console.log(name, "paused"); }
          finally { await queue.close(); }
        }
      })().catch(error => { console.error(error); process.exit(1); });'
fi
services_switched=true
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d \
  --no-build --no-deps backend frontend
if ! wait_for_backend 24; then
  docker compose -f docker-compose.prod.yml --env-file .env.prod logs --tail=120 backend
  exit 1
fi
if ! wait_for_frontend 24; then
  docker compose -f docker-compose.prod.yml --env-file .env.prod logs --tail=120 frontend
  exit 1
fi

restore_primary_routes
rollback_armed=false
# Allow in-flight webhook acceptance on the old backend to finish.
sleep 220
stop_standby
resume_background_queues
docker image prune -f --filter 'until=168h'
docker builder prune -af --filter 'until=168h' --keep-storage 2GB
journalctl --vacuum-size=300M || true
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
