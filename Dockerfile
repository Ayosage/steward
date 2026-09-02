# Steward Discord bot + result-webhook HTTP server (single Node process).
# Build: docker build -t steward .
# Run:   docker run --env-file .env -p 8787:8787 steward
# Migrations are applied at container start (docker-entrypoint.sh -> node dist/migrate.js).

# --- build: compile TypeScript to dist/ ---------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npm run build

# --- runtime: production deps only, non-root ----------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist dist
COPY drizzle drizzle
COPY docker-entrypoint.sh ./

USER node
EXPOSE 8787
ENTRYPOINT ["./docker-entrypoint.sh"]
