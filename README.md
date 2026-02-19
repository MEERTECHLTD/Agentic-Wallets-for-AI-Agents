# Agentic Wallets for AI Agents

> **Superteam Nigeria – DeFi Developer Challenge**
> Autonomous AI agent wallets on **Solana Devnet**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Solana Devnet](https://img.shields.io/badge/network-devnet-blue)](https://explorer.solana.com/?cluster=devnet)
[![Docker](https://img.shields.io/badge/docker-ready-blue)](Dockerfile)
[![LLM Powered](https://img.shields.io/badge/AI-Claude%20%7C%20rule--based-purple)](src/agent/LLMDecisionEngine.js)

---

## Overview

A complete, production-grade **agentic wallet system** that enables AI agents to autonomously:

- **Create wallets programmatically** with AES-256-GCM encrypted key storage
- **Sign and broadcast transactions** automatically — no human approval needed
- **Hold SOL and SPL tokens** on Solana devnet
- **Interact with DeFi protocols** — real on-chain SOL transfers, SPL token minting, memo-based event sourcing
- **Simulate DEX swaps** via Jupiter Aggregator API (SOL → USDC routing)
- **Make AI-powered decisions** using Anthropic Claude LLM (with rule-based fallback)
- **Multi-sig approvals** for high-value operations (M-of-N co-signing)
- **Scale to N independent agents** running concurrently, each with their own wallet
- **Observe in real time** via web dashboard (WebSocket) or interactive CLI
- **Persist history** across runs with JSON-backed state store

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     AI Decision Layer                               │
│  LLMDecisionEngine (Claude API) ◄─► DecisionEngine (rule fallback) │
│  AgentRunner (timer loop)                                           │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ instructs
┌─────────────────────────────▼───────────────────────────────────────┐
│                    DeFi Protocol Layer                              │
│  DeFiProtocol (trades · memos · rebalance · yield)                 │
│  JupiterClient (DEX swap simulation via Jupiter API)               │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ calls signAndSend()
┌─────────────────────────────▼───────────────────────────────────────┐
│                      Wallet Layer                                   │
│  WalletManager  – keypair · signing · balances · AES-256-GCM store │
│  KeyVault       – in-process agentId → wallet registry             │
│  MultiSigManager – M-of-N co-signing for high-value txns           │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ RPC
┌─────────────────────────────▼───────────────────────────────────────┐
│                   Solana Devnet (RPC)                               │
│  SystemProgram · SPL Token Program · Memo Program                  │
└─────────────────────────────────────────────────────────────────────┘

Side systems:
  AgentStateStore – JSON-file persistent history
  Web Dashboard   – Express + WebSocket real-time UI (port 3000)
  CLI Observer    – inquirer.js interactive menu
```

**Core security principle:** Private keys **never leave** `WalletManager`. Agent logic, the LLM, and all protocol calls only see public keys and transaction signatures.

---

## Project Structure

```
├── src/
│   ├── config.js                  # Central config, shared Connection
│   ├── index.js                   # Public API surface
│   ├── wallet/
│   │   ├── WalletManager.js       # Keypair lifecycle, signing, balances
│   │   ├── KeyVault.js            # In-process agent→wallet registry
│   │   └── MultiSigManager.js     # M-of-N co-signing proposals
│   ├── agent/
│   │   ├── DecisionEngine.js      # Rule-based autonomous FSM
│   │   ├── LLMDecisionEngine.js   # Claude-powered decision engine
│   │   └── AgentRunner.js         # Timer loop, lifecycle management
│   ├── defi/
│   │   ├── DeFiProtocol.js        # Trades, memos, rebalance, yield
│   │   ├── JupiterClient.js       # Jupiter DEX swap integration
│   │   └── SolanaClient.js        # RPC helper utilities
│   ├── db/
│   │   └── AgentStateStore.js     # JSON-file persistent history
│   ├── dashboard/
│   │   └── server.js              # Express + WebSocket dashboard
│   ├── harness/
│   │   ├── multi-agent.js         # N-agent concurrent harness
│   │   ├── test-suite.js          # Automated on-chain tests
│   │   └── benchmark.js           # Performance benchmark harness
│   ├── cli/
│   │   └── observer.js            # Interactive CLI dashboard
│   ├── demo.js                    # 2-agent quick demo
│   ├── demo-llm.js                # LLM + Jupiter swap demo
│   └── utils/
│       ├── logger.js              # Winston structured logging
│       └── crypto.js              # AES-256-GCM key encryption
├── Dockerfile                     # Multi-stage production container
├── docker-compose.yml             # Dashboard + headless + demo services
├── SKILLS.md                      # Machine-readable capability manifest
├── DEEP_DIVE.md                   # Architecture & security deep dive
├── .env.example                   # Environment variable template
└── package.json
```

---

## Quick Start

### Prerequisites

- **Node.js ≥ 18** (ESM support required)
- Internet connection (Solana devnet RPC + Jupiter API)
- No Solana CLI required

### 1. Install

```bash
git clone <repo-url> agentic-wallets
cd agentic-wallets
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
WALLET_PASSPHRASE=your-strong-secret-passphrase

# Optional: enable LLM-powered decisions
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Run the Quick Demo

```bash
npm run demo
```

Creates 2 agents, runs 3 autonomous decision cycles, shows balances and stats.

### 4. Run the LLM + Jupiter Demo

```bash
npm run llm-demo
```

- Connects to **Anthropic Claude API** for AI decisions
- **Simulates a Jupiter DEX swap** (SOL → USDC routing, on-chain memo)
- Falls back to rule-based decisions without an API key

### 5. Web Dashboard (Recommended)

```bash
npm run dashboard
```

Open **http://localhost:3000** — shows live agent cards with balances, states, trade counts, and a real-time event feed via WebSocket.

### 6. Multi-Agent Harness

```bash
npm run multi
# or: node src/harness/multi-agent.js 5 300
```

Spawns 3–N agents running concurrently on devnet for configurable duration.

### 7. Interactive CLI Observer

```bash
npm run cli
```

Menu-driven interface to list wallets, start/stop agents, request airdrops, transfer SOL, view stats.

### 8. Run Tests

```bash
npm test
```

Automated on-chain test suite: wallet creation, key uniqueness, balance queries, SOL transfer, SPL token balance, memo logging, wallet enumeration.

### 9. Benchmark

```bash
npm run benchmark
# or: node src/harness/benchmark.js --agents 3 --cycles 5
```

Measures wallet creation latency, balance query throughput, decision cycle latency, and concurrent multi-agent throughput with P50/P95/P99 percentiles.

---

## Docker

### Single command

```bash
docker build -t agentic-wallets .
docker run -p 3000:3000 \
  -e WALLET_PASSPHRASE=secret \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  agentic-wallets
```

### Docker Compose

```bash
# Web dashboard + 3 agents
docker compose up dashboard

# Headless harness (no UI)
docker compose --profile headless up agents

# Quick demo
docker compose --profile demo run demo

# LLM demo
docker compose --profile llm run llm-demo
```

---

## LLM Integration

The `LLMDecisionEngine` calls the **Anthropic Claude API** to make decisions:

```
Agent state snapshot (JSON)
  ↓  sent to Claude
  balanceSOL, cycleNumber, peers[{agentId, balanceSOL}], availablePeerIds
  ↓
Claude response (JSON):
  { "action": "TRADE"|"IDLE"|"YIELD"|"REBAL",
    "reason": "peer agent-02 has much lower balance",
    "tradeTarget": "agent-02",
    "tradeAmount": 0.008 }
  ↓  validated & safety-checked
  ↓  executed via WalletManager
```

Safety guarantees regardless of LLM output:
- `tradeAmount > AGENT_MAX_SOL_PER_TX` → capped automatically
- `balance - tradeAmount < 0.003` → downgraded to IDLE
- Invalid action name → defaulted to IDLE
- API timeout/error → rule-based fallback

---

## Multi-Sig Support

High-value operations require M-of-N agent co-signatures:

```js
import { MultiSigManager } from "./src/wallet/MultiSigManager.js";

const msig = new MultiSigManager();

// Alice proposes a 0.5 SOL transfer (requires 2-of-3)
const proposal = await msig.createTransferProposal(
  alice, destination, 0.5, "Treasury transfer",
  2, [bob, carol]  // 2-of-3 required
);

// Bob co-signs
await msig.coSign(proposal.proposalId, bob);
// Proposal approved (2/2)

// Execute
const sig = await msig.execute(proposal.proposalId, alice);
```

---

## Jupiter DEX Integration

```js
import { JupiterClient, TOKENS } from "./src/defi/JupiterClient.js";

const jupiter = new JupiterClient();

// Get best route quote (SOL → USDC)
const quote = await jupiter.getQuote(TOKENS.SOL, TOKENS.USDC, 1_000_000); // 0.001 SOL

// Simulate swap on devnet (records on-chain via Memo Program)
const result = await jupiter.simulateSwap(wallet, TOKENS.SOL, TOKENS.USDC, 1_000_000);
// { inAmount, outAmount, priceImpact, signature, simulated: true }

// Execute real swap (mainnet with funded account)
const { signature } = await jupiter.executeSwap(wallet, TOKENS.SOL, TOKENS.USDC, 1_000_000);
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLANA_NETWORK` | `devnet` | Solana cluster |
| `SOLANA_RPC_URL` | devnet RPC | Custom RPC URL |
| `WALLET_STORAGE_DIR` | `./wallets` | Encrypted wallet directory |
| `WALLET_PASSPHRASE` | (weak default) | AES-256-GCM passphrase – **change this** |
| `ANTHROPIC_API_KEY` | (optional) | Claude API key for LLM decisions |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude model ID |
| `AUTO_AIRDROP` | `true` | Airdrop on wallet creation |
| `AIRDROP_AMOUNT_SOL` | `1` | Devnet airdrop amount |
| `AGENT_DECISION_INTERVAL_MS` | `20000` | Decision tick interval |
| `AGENT_MAX_SOL_PER_TX` | `0.01` | Per-transaction spend cap |
| `DASHBOARD_PORT` | `3000` | Web dashboard port |
| `AGENT_IDS` | `agent-01,agent-02,agent-03` | Dashboard agent IDs |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `DB_PATH` | `./data/agent-state.json` | State persistence file |

---

## Security

| Concern | Solution |
|---------|----------|
| Key storage | AES-256-GCM; unique 32-byte salt per wallet |
| Key derivation | PBKDF2-SHA-512, 210,000 iterations |
| Key isolation | Private key never leaves `WalletManager` |
| LLM safety | Hard spend cap; balance floor; action whitelist |
| High-value txns | M-of-N multi-sig proposals |
| Audit trail | Every action logged on-chain via Memo Program |
| Spend limits | `AGENT_MAX_SOL_PER_TX` + `balance > 0.02` gate |
| Network scope | Devnet default; mainnet requires explicit config |

See [DEEP_DIVE.md](DEEP_DIVE.md) for the full security analysis and threat model.

---

## On-Chain Verification

All transactions are real and verifiable on **Solana devnet**:

```
https://explorer.solana.com/?cluster=devnet
```

Search by agent public key to see all transactions including trades, memo events, and token operations.

---

## Extending the Decision Engine

The LLM plug-in point is `DecisionEngine._decide()` — swap it with any inference backend:

```js
// OpenAI GPT-4o
import OpenAI from "openai";
const openai = new OpenAI();
async _decide(balance) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: `bal=${balance} peers=${this.peers.length}. Decide: IDLE|TRADE|YIELD|REBAL` }]
  });
  return r.choices[0].message.content.trim();
}

// Anthropic Claude (already implemented in LLMDecisionEngine.js)
// Ollama local model
// Reinforcement learning policy network
// Custom rule engine
```

---

## License

MIT – see [LICENSE](LICENSE)

---

*Built for the Superteam Nigeria DeFi Developer Challenge – Agentic Wallets for AI Agents (2026).*
