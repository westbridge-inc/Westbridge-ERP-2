# ──────────────────────────────────────────────────────────────────────────────
# Westbridge ERP Backend — Multi-stage Docker build
# ──────────────────────────────────────────────────────────────────────────────

# Stage 1: Install dependencies and build
FROM node:20-alpine AS builder

WORKDIR /app

# Install OS deps required for bcrypt native compilation
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# Generate Prisma client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: Production image (minimal)
FROM node:20-alpine AS production

WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 -S westbridge && \
    adduser -S westbridge -u 1001 -G westbridge

# Copy only production dependencies
COPY package.json package-lock.json ./
# --ignore-scripts skips the prepare hook (husky is a devDependency, unavailable here)
RUN npm ci --legacy-peer-deps --omit=dev --ignore-scripts && npm cache clean --force

# Copy Prisma schema, migrations, generated client, and CLI dependencies
COPY prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Switch to non-root user
USER westbridge

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/api/health || exit 1

EXPOSE 4000

ENV NODE_ENV=production
ENV PORT=4000

CMD ["node", "dist/server.js"]
