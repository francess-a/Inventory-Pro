# Single image: builds the React app and runs it from the Node server alongside the API.

FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package*.json ./
COPY server/prisma ./prisma
RUN npm ci --no-audit --no-fund && npx prisma generate
COPY server/src ./src
COPY --from=web /web/build /app/frontend/build
ENV NODE_ENV=production PORT=5100 FRONTEND_DIR=/app/frontend/build
EXPOSE 5100
# Apply pending database migrations, then start.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
