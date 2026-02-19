# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile – Agentic Wallets for AI Agents
# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage build:
#   Stage 1 (deps)  – install production deps only
#   Stage 2 (final) – minimal runtime image
#
# Usage:
#   docker build -t agentic-wallets .
#   docker run -e WALLET_PASSPHRASE=secret -e ANTHROPIC_API_KEY=sk-ant-... agentic-wallets
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Install dependencies ────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Install build tools for native modules (better-sqlite3, bigint-buffer)
RUN apk add --no-cache python3 make g++ git

COPY package.json package-lock.json* ./
RUN npm ci --only=production

# ── Stage 2: Runtime image ────────────────────────────────────────────────────
FROM node:20-alpine AS final
WORKDIR /app

# Security: run as non-root user
RUN addgroup -g 1001 -S agentuser && adduser -u 1001 -S agentuser -G agentuser

# Copy production deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json .

# Create directories with proper ownership
RUN mkdir -p /app/wallets /app/logs /app/data && \
    chown -R agentuser:agentuser /app

USER agentuser

# Environment defaults (override in docker run / docker-compose)
ENV NODE_ENV=production
ENV SOLANA_NETWORK=devnet
ENV SOLANA_RPC_URL=https://api.devnet.solana.com
ENV WALLET_STORAGE_DIR=/app/wallets
ENV LOG_FILE=/app/logs/agent.log
ENV AUTO_AIRDROP=true
ENV AIRDROP_AMOUNT_SOL=1
ENV AGENT_DECISION_INTERVAL_MS=20000
ENV AGENT_MAX_SOL_PER_TX=0.01
ENV LOG_LEVEL=info
ENV DASHBOARD_PORT=3000

# Persist wallet files and logs
VOLUME ["/app/wallets", "/app/logs", "/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/agents', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Default: run the web dashboard (agents auto-start via setTimeout)
CMD ["node", "src/dashboard/server.js"]
