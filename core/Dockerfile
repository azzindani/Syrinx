# Core: Node 24 + Fastify gateway. No ML deps, CPU-only.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vitest.config.ts ./
COPY src/ ./src/
RUN npm run build

# React shell served by core at /app/.
FROM node:24-slim AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src/ ./src/
RUN npm run build

FROM node:24-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=webbuild /web/dist ./web/dist
EXPOSE 3001
HEALTHCHECK --interval=5s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3001/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
