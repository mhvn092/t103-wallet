# syntax=docker/dockerfile:1

FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

EXPOSE 3000
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/main.js"]
