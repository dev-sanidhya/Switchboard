# --- build stage ---
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build

# --- runtime stage ---
FROM node:20-alpine AS runner

WORKDIR /app

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 switchboard

# Copy compiled output and production deps only
COPY --from=builder --chown=switchboard:nodejs /app/dist ./dist
COPY --from=builder --chown=switchboard:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=switchboard:nodejs /app/package.json ./package.json
# Migrations must be reachable at runtime (path referenced from dist/db/migrate.js)
COPY --from=builder --chown=switchboard:nodejs /app/src/db/migrations ./src/db/migrations

USER switchboard

EXPOSE 3000

ENV NODE_ENV=production

# Runs migrations then starts the gateway
CMD ["node", "dist/main.js"]
