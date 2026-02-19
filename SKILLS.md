# SKILLS.md
## Machine-Readable Capability Manifest for AI Agents

> This file is written for AI agents to read and understand the capabilities,
> interfaces, constraints, and extension points of this agentic wallet system.

---

## Identity

```
system:    agentic-wallets-for-ai-agents
version:   2.0.0
network:   solana-devnet (mainnet-configurable)
language:  JavaScript (ESM, Node >= 18)
ai_engine: anthropic/claude-haiku-4-5-20251001 (with rule-based fallback)
```

---

## Capabilities

### WALLET_CREATE
Create a new Ed25519 keypair, encrypt with AES-256-GCM (PBKDF2-SHA-512), persist to disk.

```
input:  agentId (string)
output: { publicKey: string, agentId: string }
effect: writes ./wallets/<agentId>.wallet.enc
cost:   0 SOL (no transaction)
```

### WALLET_LOAD
Decrypt and load an existing wallet from disk.

```
input:  agentId (string)
output: { publicKey: string, agentId: string }
prereq: wallet file must exist
```

### WALLET_GET_OR_CREATE
Load existing wallet or create new one (idempotent).

```
input:  agentId (string)
output: { publicKey: string, agentId: string }
```

### BALANCE_SOL
Query the SOL balance of an agent wallet.

```
input:  agentId (string)
output: number (SOL, float)
rpc:    getBalance
```

### BALANCE_TOKEN
Query SPL token balance for a given mint.

```
input:  agentId (string), mintAddress (string base58)
output: number (raw units, integer). Returns 0 if ATA does not exist.
rpc:    getAccount
```

### SEND_SOL
Transfer SOL from one agent to another address.

```
input:  fromAgentId (string), toAddress (string base58), amountSOL (float)
output: transactionSignature (string)
effect: on-chain transfer, irreversible
constraint: amountSOL <= AGENT_MAX_SOL_PER_TX (env, default 0.01)
cost:   ~0.000005 SOL tx fee
```

### SIGN_TX
Sign and broadcast an arbitrary pre-built Transaction object.

```
input:  agentId (string), transaction (solana Transaction)
output: transactionSignature (string)
note:   private key never leaves WalletManager
```

### AIRDROP
Request a SOL airdrop on devnet.

```
input:  agentId (string), amountSOL (float, max 2.0 on devnet)
output: void
network: devnet only
note:   rate-limited by Solana faucet
```

### MINT_TOKEN
Create a new SPL token mint and mint initial supply to agent's ATA.

```
input:  agentId (string), supplyUnits (integer)
output: { mint: string, ata: string, signature: string }
cost:   ~0.002 SOL for rent-exemption
```

### LOG_MEMO
Write a UTF-8 memo string on-chain via the Solana Memo Program.

```
input:  agentId (string), memo (string, max ~566 bytes)
output: transactionSignature (string)
use:    immutable on-chain audit trail / event sourcing
cost:   ~0.000005 SOL
```

### TRADE
Execute an autonomous SOL trade from agent A to agent B.

```
input:  fromAgentId (string), toPublicKey (string), amountSOL (float)
output: transactionSignature (string)
effect: SOL transfer + on-chain TRADE memo event
```

### REBALANCE_POOL
Redistribute SOL across a pool of agents toward a target average.

```
input:  wallets (WalletManager[]), targetSOL (float)
output: void (multiple on-chain transfers)
strategy: rich agents donate to poor agents
```

### SIMULATE_SWAP
Simulate a Jupiter DEX swap and log the result on-chain.

```
input:  agentId, inputMint, outputMint, inputAmountLamports
output: { signature, inAmount, outAmount, priceImpact, simulated: true }
note:   fetches real Jupiter quote then logs via Memo Program on devnet
        real swap execution available via executeSwap() on mainnet
```

### JUPITER_QUOTE
Fetch the best swap route from Jupiter Aggregator.

```
input:  inputMint (string), outputMint (string), inputAmount (lamports), slippageBps (int, default 50)
output: QuoteResponse (route, amounts, price impact)
api:    https://quote-api.jup.ag/v6/quote
```

### AGENT_TICK
Execute one autonomous decision cycle for an agent.

```
input:  agentId (string)
output: void
states: IDLE | TRADE | YIELD | REBAL
trigger: called by AgentRunner on a timer
note:   LLMDecisionEngine calls Claude API; falls back to rules on error
```

### MULTISIG_PROPOSE
Create a multi-sig proposal for a high-value transfer.

```
input:  proposerWallet, toAddress, amountSOL, description, requiredSigners, coSigners[]
output: MultiSigProposal { proposalId, status: "PENDING", ... }
```

### MULTISIG_COSIGN
Co-sign an existing multi-sig proposal.

```
input:  proposalId (string), signerWallet
output: { proposal, approved: boolean }
note:   proposal auto-transitions to APPROVED when M signatures collected
```

### MULTISIG_EXECUTE
Broadcast an approved multi-sig transaction.

```
input:  proposalId (string), executorWallet
output: transactionSignature (string)
prereq: proposal.status === "APPROVED"
```

### STATE_LOG_DECISION
Persist a decision event to the agent state store.

```
input:  agentId, cycle, prevState, nextState, balanceSOL, reason, source
output: void
persist: ./data/agent-state.json (auto-flushed every 30s)
```

### STATE_LOG_ACTION
Persist an action event to the agent state store.

```
input:  agentId, action, amountSOL, targetAgentId, signature, source, reason
output: void
```

### STATE_GET_STATS
Retrieve aggregated statistics for an agent from persistent history.

```
input:  agentId (string)
output: { totalCycles, tradeDecisions, avgBalance, minBalance, maxBalance, totalVolume, tradeCount }
```

---

## Decision State Machine

```
┌─────────────────────────────────────────────────────────┐
│                         IDLE                            │  ← default / safe fallback
└───────┬─────────────────────────────────────────────────┘
        │
        │  Evaluated each tick (priority order):
        │  1. balance < 0.003 SOL        → IDLE  (safety floor)
        │  2. cycle % 7 == 0             → YIELD (periodic yield)
        │  3. cycle % 12 == 0 & peers>0  → REBAL (pool rebalance)
        │  4. peers > 0 & balance > 0.02 → TRADE (peer trade)
        │  5. default                    → IDLE
        │
        │  LLM override (LLMDecisionEngine):
        │  All rules replaced by Claude API call with same state names
        │  Hard safety gates still enforced after LLM decision
        │
   ┌────▼───┐    ┌───────┐    ┌───────┐
   │ TRADE  │    │ YIELD │    │ REBAL │
   └────────┘    └───────┘    └───────┘
   All states fall back to IDLE on error
```

---

## Security Model

| Property | Implementation |
|----------|---------------|
| Key storage at rest | AES-256-GCM, 256-bit key |
| Key derivation | PBKDF2-SHA-512, 210,000 iterations, 32-byte unique salt |
| Key in memory | Uint8Array in WalletManager._keypair (never serialised) |
| Key exposure to agent | NEVER – agent receives only publicKey (string) |
| LLM safety | Hard cap on tradeAmount; balance floor check; action whitelist |
| Multi-sig | M-of-N co-signing for high-value ops |
| Spend limit | AGENT_MAX_SOL_PER_TX (env, default 0.01 SOL) |
| Balance floor | Never trade below 0.003 SOL |
| Audit trail | Every action + swap logged on-chain via Memo Program |
| Network scope | Devnet default; mainnet via SOLANA_NETWORK=mainnet-beta |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| SOLANA_NETWORK | devnet | Solana cluster |
| SOLANA_RPC_URL | devnet RPC | Custom RPC endpoint |
| WALLET_STORAGE_DIR | ./wallets | Encrypted wallet directory |
| WALLET_PASSPHRASE | (insecure default) | AES-256-GCM passphrase |
| ANTHROPIC_API_KEY | (optional) | Enable LLM decisions |
| CLAUDE_MODEL | claude-haiku-4-5-20251001 | Model to use |
| AUTO_AIRDROP | true | Airdrop on wallet creation |
| AIRDROP_AMOUNT_SOL | 1 | Devnet airdrop amount |
| AGENT_DECISION_INTERVAL_MS | 20000 | Tick interval per agent |
| AGENT_MAX_SOL_PER_TX | 0.01 | Per-tx spend cap |
| DASHBOARD_PORT | 3000 | Web dashboard port |
| AGENT_IDS | agent-01,agent-02,agent-03 | Dashboard agents |
| DB_PATH | ./data/agent-state.json | Persistent state file |
| LOG_LEVEL | info | winston log level |

---

## Module Graph

```
src/
├── config.js                  ← central config, shared Connection
├── index.js                   ← public API surface
├── wallet/
│   ├── WalletManager.js       ← keypair lifecycle, signing, balances
│   ├── KeyVault.js            ← in-process registry
│   └── MultiSigManager.js     ← M-of-N proposal/co-sign/execute
├── agent/
│   ├── DecisionEngine.js      ← rule-based FSM, EventEmitter
│   ├── LLMDecisionEngine.js   ← Claude API decisions, extends DecisionEngine
│   └── AgentRunner.js         ← timer loop, lifecycle
├── defi/
│   ├── DeFiProtocol.js        ← trades, memos, rebalance, yield
│   ├── JupiterClient.js       ← Jupiter DEX swap API
│   └── SolanaClient.js        ← RPC helpers
├── db/
│   └── AgentStateStore.js     ← JSON-file persistent history
├── dashboard/
│   └── server.js              ← Express + WebSocket real-time UI
├── harness/
│   ├── multi-agent.js         ← N-agent concurrent harness
│   ├── test-suite.js          ← automated on-chain tests
│   └── benchmark.js           ← latency/throughput benchmarks
├── cli/
│   └── observer.js            ← interactive CLI
└── utils/
    ├── logger.js              ← Winston structured logging
    └── crypto.js              ← AES-256-GCM helpers
```

---

## Invocation Examples

```js
import {
  WalletManager, DeFiProtocol, DecisionEngine,
  LLMDecisionEngine, JupiterClient
} from "agentic-wallets-for-ai-agents";

// Create or load wallet
const wm = new WalletManager("my-agent");
await wm.getOrCreate();

// Query balance
const sol = await wm.getSOLBalance(); // → 1.0

// Transfer SOL
const sig = await wm.sendSOL("destination_pubkey_base58", 0.001);

// Rule-based agent
const proto = new DeFiProtocol();
const engine = new DecisionEngine("my-agent", wm, proto, []);
await engine.tick();

// LLM-powered agent (requires ANTHROPIC_API_KEY)
const llmEngine = new LLMDecisionEngine("my-agent", wm, proto, []);
await llmEngine.tick();
// → Claude decides action, reason logged, safety gates enforced

// Jupiter swap simulation
const jupiter = new JupiterClient();
const { outAmount, priceImpact } = await jupiter.simulateSwap(
  wm, TOKENS.SOL, TOKENS.USDC, 1_000_000
);

// Multi-sig proposal
import { MultiSigManager } from "./src/wallet/MultiSigManager.js";
const msig = new MultiSigManager();
const proposal = await msig.createTransferProposal(
  walletA, destination, 0.5, "treasury", 2, [walletB, walletC]
);
await msig.coSign(proposal.proposalId, walletB);
const txSig = await msig.execute(proposal.proposalId, walletA);
```

---

## Supported Token Addresses (devnet/mainnet)

```js
import { TOKENS } from "agentic-wallets-for-ai-agents/src/defi/JupiterClient.js";

TOKENS.SOL   // So11111111111111111111111111111111111111112  (Wrapped SOL)
TOKENS.USDC  // EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
TOKENS.USDT  // Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
TOKENS.BONK  // DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
TOKENS.JUP   // JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN
```
