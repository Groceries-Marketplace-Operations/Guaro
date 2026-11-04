FROM node:20-alpine AS backend-builder
RUN apk add --no-cache openssl
WORKDIR /app
COPY prisma ./prisma/
COPY backend/package*.json ./
RUN npm ci --no-audit --no-fund
RUN npx prisma generate --schema=./prisma/schema.prisma
COPY backend/. .
RUN npm run build

FROM node:22-alpine AS promo-deps
WORKDIR /app/promo-manager
COPY promo-manager/package*.json ./
COPY promo-manager/vendor ./vendor
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
# Prisma selects its linux-musl OpenSSL 3 engine by probing this executable.
# The Node 22 base has libssl.so.3 but not /usr/bin/openssl.
COPY --from=backend-builder /usr/bin/openssl /usr/bin/openssl
RUN openssl version
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=backend-builder /app/dist ./dist
COPY --from=backend-builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=backend-builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY promo-manager ./promo-manager
COPY frontend/public/promo-manager ./promo-manager/web
COPY --from=promo-deps /app/promo-manager/node_modules ./promo-manager/node_modules
RUN mkdir -p /app/promo-manager/output && chown -R node:node /app/promo-manager/output
USER node
ENV NODE_ENV=production
ENV PROMO_SFTP_LOCAL_RUNNER=1
ENV PROMO_BACKEND_CWD=/app
ENV PROMO_UI_HOST=0.0.0.0
EXPOSE 5373
CMD ["node", "--use-system-ca", "promo-manager/src/server.mjs"]
