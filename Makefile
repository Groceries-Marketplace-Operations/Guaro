DC = docker compose -f docker-compose.prod.yml

# ── Deploy ────────────────────────────────────────────────────────────────────
deploy:
	git pull
	$(DC) build --no-cache backend frontend
	$(DC) up -d

deploy-backend:
	git pull
	$(DC) build --no-cache backend
	$(DC) up -d backend

deploy-frontend:
	git pull
	$(DC) build --no-cache frontend
	$(DC) up -d frontend

# ── Database ──────────────────────────────────────────────────────────────────
migrate:
	$(DC) exec backend npx prisma migrate deploy

# ── Logs ─────────────────────────────────────────────────────────────────────
logs:
	$(DC) logs -f --tail=100

logs-backend:
	$(DC) logs -f --tail=100 backend

# ── Scripts de importación ────────────────────────────────────────────────────
import-brands:
	$(DC) exec backend node dist/scripts/import-brands.js /tmp/brands.xlsx

import-applications:
	$(DC) exec backend node dist/scripts/import-applications.js /tmp/apps.xlsx

.PHONY: deploy deploy-backend deploy-frontend migrate logs logs-backend import-brands import-applications
