# Deep Dive: Agentic Wallets for AI Agents

> Full technical analysis: wallet design, security model, AI integration, DeFi protocols, scalability, and mainnet readiness.

---

## 1. Problem Statement

Traditional Solana wallets require interactive approval for every transaction — a browser extension prompt, a hardware device tap, or a mobile notification. An AI agent cannot click "Approve."

For AI agents to become autonomous on-chain participants — executing trades, managing liquidity, providing yield, interacting with governance — they need:

1. **Programmatic wallet generation** — no human ceremony
2. **Automatic signing** — transaction execution in response to agent decisions
3. **Safe key storage** — persistent, encrypted, tamper-evident
4. **Spend controls** — hard limits so an agent cannot drain itself
5. **Multi-sig governance** — high-value operations require M-of-N approval
6. **AI-native decision making** — LLM or policy-network-powered strategy
7. **DeFi protocol integration** — real DEX routing, not mock transfers
8. **Observability** — humans must be able to audit agent behaviour

This project delivers all eight.

---

## 2. Wallet Design

### 2.1 Key Generation

Each agent wallet is a standard **Ed25519 keypair** via `@solana/web3.js`'s `Keypair.generate()`, compatible with all Solana tooling.

```
Keypair {
  publicKey:  32-byte Ed25519 public key  (safe to share, stored in plaintext)
  secretKey:  64-byte secret key          (AES-256-GCM encrypted at rest)
}
```

### 2.2 Encrypted Storage at Rest

The secret key is Base58-encoded and encrypted before writing to disk:

```
Stored file (hex-encoded binary):
┌──────────────────┬──────────┬──────────┬────────────────┐
│  PBKDF2 salt     │    IV    │ Auth tag │  Ciphertext    │
│  32 bytes        │  12 bytes│ 16 bytes │  variable      │
└──────────────────┴──────────┴──────────┴────────────────┘
Wrapped in JSON: { agentId, publicKey, encryptedSecret, createdAt }
```

**Algorithm:** AES-256-GCM (NIST SP 800-38D)
**Key derivation:** PBKDF2-SHA-512, **210,000 iterations** (OWASP 2023 minimum), unique 32-byte salt per wallet
**Authentication:** 16-byte GCM auth tag detects any tampering (bit-flip protection)

### 2.3 Private Key Isolation

`WalletManager` is the only class that holds private key material. The public API surface exposed to all other layers:

```
publicKey              → string (safe to share)
getSOLBalance()        → Promise<number>
getTokenBalance(mint)  → Promise<number>
sendSOL(to, amount)    → Promise<signature>
signAndSend(tx)        → Promise<signature>
signOnly(tx)           → Transaction (offline signing)
airdrop(amount)        → Promise<void>
```

No method returns a private key. The `_keypair` field is private by convention. Agent logic, LLM responses, and DeFi protocol calls **never receive** raw key material.

> **Exception:** `DeFiProtocol.mintAgentToken()` accesses `_keypair` directly because `@solana/spl-token`'s `createMint()` requires a `Signer` object. This is documented and is a known devnet-prototype trade-off. Production would use a Program Derived Address (PDA) or delegate mint authority to a multi-sig.

### 2.4 KeyVault

The `KeyVault` class is an in-process registry mapping `agentId → WalletManager`. It enforces:
- One `WalletManager` instance per agent (no duplicate objects)
- All consumers share the same instance (no double-loading)
- Registration logs to the audit trail

---

## 3. AI Agent Architecture

### 3.1 Two-Engine Design

The system provides two interchangeable decision engines:

| Engine | Source | Use case |
|--------|--------|----------|
| `DecisionEngine` | Rule-based FSM | Offline demo, no API key needed |
| `LLMDecisionEngine` | Anthropic Claude API | Production-grade AI reasoning |

Both share the same public interface and emit the same events, so agent runners and observers work identically with either engine.

### 3.2 Finite State Machine

```
IDLE  ──► TRADE  (SOL transfer to a peer)
IDLE  ──► YIELD  (log simulated yield on-chain)
IDLE  ──► REBAL  (equalise SOL across agent pool)
Any   ──► IDLE   (error fallback, low balance)
```

States are evaluated with a priority queue each tick:

```
1. balance < 0.003 SOL          → IDLE   [safety: protect rent exemption]
2. cycle % 7 == 0               → YIELD  [periodic yield claim]
3. cycle % 12 == 0 && peers > 0 → REBAL  [pool rebalancing]
4. peers > 0 && balance > 0.02  → TRADE  [market opportunity]
5. default                       → IDLE
```

### 3.3 LLM Decision Engine

When `ANTHROPIC_API_KEY` is set, `LLMDecisionEngine` replaces the priority queue with an **Anthropic Claude API call**:

**Input to Claude:**
```json
{
  "agentId": "agent-01",
  "publicKey": "7PcaZyZn…",
  "balanceSOL": 0.872300,
  "cycleNumber": 14,
  "tradeCount": 3,
  "totalVolumeSOL": 0.021400,
  "peers": [
    { "agentId": "agent-02", "balanceSOL": 0.341200 },
    { "agentId": "agent-03", "balanceSOL": 1.100000 }
  ],
  "maxTradeSOL": 0.01,
  "availablePeerIds": ["agent-02", "agent-03"]
}
```

**Claude response:**
```json
{
  "action": "TRADE",
  "reason": "agent-02 has significantly lower balance; redistributing creates a more balanced pool",
  "tradeTarget": "agent-02",
  "tradeAmount": 0.008
}
```

**Safety layer (enforced after LLM response, cannot be bypassed):**
- `tradeAmount > AGENT_MAX_SOL_PER_TX` → capped to `AGENT_MAX_SOL_PER_TX`
- `balance - tradeAmount < 0.003` → downgraded to IDLE
- Invalid action string → defaulted to IDLE
- API timeout (15s) or error → transparent fallback to rule-based engine

This layered design means **Claude improves** agent strategy without being able to cause unsafe actions — the wallet layer enforces hard constraints regardless of what the LLM says.

### 3.4 Event-Driven Observability

`DecisionEngine` extends `EventEmitter` and emits three event types:

```
"decision" { agentId, cycle, balance, prevState, nextState, source, reason }
"action"   { agentId, action, amount, target, signature, source, reason }
"error"    { agentId, state, error }
```

Events bubble up through `AgentRunner` to the web dashboard (via WebSocket), the CLI, and the harness logger. Observers attach with `runner.on("action", handler)` and can be added or removed at runtime without affecting agent execution.

---

## 4. DeFi Protocol Layer

### 4.1 SOL Transfers (Real On-Chain)

Agent-to-agent trades use `SystemProgram.transfer()` — the most primitive Solana instruction. Every transfer:
- Pays actual transaction fees (~5,000 lamports)
- Is confirmed at "confirmed" commitment before returning
- Has its signature logged on-chain via Memo Program
- Is queryable via `getSignaturesForAddress`

### 4.2 On-Chain Event Sourcing via Memo Program

The **Solana Memo Program** (`MemoSq4g…`) allows writing arbitrary UTF-8 strings in transaction data. Agents write structured JSON to every significant action:

```json
{ "event": "TRADE", "from": "agent-01", "to": "7PcaZyZn...", "amountSOL": 0.00340000 }
{ "event": "YIELD", "agent": "agent-02", "yieldSOL": 0.000872, "timestamp": 1708378412000 }
{ "event": "SWAP_SIM", "agent": "agent-01", "inputMint": "So111111", "outputMint": "EPjFWdd5", "inAmt": "1000000", "outAmt": "145230000", "priceImpact": "0.01" }
```

This gives us:
- Immutable audit trail of all agent decisions
- On-chain event sourcing (reconstruct agent history from chain)
- Visible in Solana Explorer, queryable via RPC
- Zero cost beyond transaction fees

### 4.3 Jupiter DEX Swap Integration

The `JupiterClient` integrates with [Jupiter's V6 Quote API](https://station.jup.ag/docs/apis/swap-api), the leading DEX aggregator on Solana.

**Quote flow:**
```
JupiterClient.getQuote(SOL, USDC, 1_000_000)
  → GET https://quote-api.jup.ag/v6/quote?inputMint=So11...&outputMint=EPjF...&amount=1000000
  → { inAmount: "1000000", outAmount: "145230000", priceImpactPct: "0.01",
      routePlan: [{ swapInfo: { label: "Raydium" } }] }
```

**Devnet behaviour:**
- Jupiter API is mainnet-only (no devnet liquidity)
- `simulateSwap()` fetches the real mainnet quote to demonstrate routing
- Logs the simulated trade on-chain via Memo Program as proof of capability
- `executeSwap()` performs the real swap on mainnet with a funded account

### 4.4 SPL Token Management

Agents can create their own SPL token mint and hold tokens:
- `createMint()` — create a new mint with agent as mint authority
- `getOrCreateAssociatedTokenAccount()` — create ATA
- `mintTo()` — mint tokens to agent's ATA
- `getTokenBalance()` — query ATA balance (returns 0 if ATA doesn't exist)

### 4.5 Pool Rebalancing

The rebalancing algorithm equalises SOL across a pool of agents:

```
Algorithm:
  1. Query all agent balances
  2. Compute pool average
  3. For each below-average agent (receiver):
     For each above-average agent (donor):
       transfer = min(needed, donor_surplus - 0.001_fee_buffer)
       if transfer > 0: donor.sendSOL(receiver, transfer)
```

This models a **liquidity manager** that redistributes capital to prevent any agent from being stranded with insufficient balance.

---

## 5. Multi-Signature Support

High-value operations require M-of-N agent approval before execution.

### 5.1 Proposal Lifecycle

```
PENDING  ──► APPROVED  ──► EXECUTED
              ↑
              M signatures collected
```

### 5.2 Implementation

1. **Proposer** calls `createTransferProposal()` → builds `SystemProgram.transfer()` transaction, partially signs it
2. **Co-signers** call `coSign(proposalId, wallet)` → each signs the same transaction object
3. When `signatureCount >= requiredSigners`, status → APPROVED automatically
4. **Executor** calls `execute(proposalId, wallet)` → broadcasts the fully-signed transaction

### 5.3 Use Cases

| Scenario | Configuration |
|----------|--------------|
| Treasury management | 2-of-3 agents must agree |
| Emergency withdrawal | 3-of-5 agents |
| Daily rebalancing | 1-of-N (single agent can trigger) |

### 5.4 Production Enhancement

For mainnet, use **Squads Protocol** (https://squads.so) which provides:
- On-chain multi-sig program with time-locks
- Threshold signatures via Threshold-BLS
- Role-based access control for different spending tiers

---

## 6. Persistent State Store

The `AgentStateStore` persists agent history to a JSON file (`./data/agent-state.json`):

- **Decision history:** every FSM decision with balance, reason, source (rule/llm)
- **Action history:** trades, yields, rebalances with amounts and signatures
- **Swap history:** Jupiter swap data (simulated and real)
- **Agent identities:** agentId, publicKey, createdAt

Auto-flushes to disk every 30 seconds. Survives process restarts — agents resume with full history.

---

## 7. Security Considerations

### 7.1 Threat Model

| Threat | Impact | Mitigation |
|--------|--------|-----------|
| Disk theft / file exfiltration | Private key exposure | AES-256-GCM + unique PBKDF2 salt (210k iterations) |
| Memory dump | Private key in RAM | Keys held as Uint8Array; never serialised to logs or network |
| LLM hallucination | Unsafe transaction | Hard spend cap; balance floor; action whitelist after LLM response |
| Agent overspending | Wallet drain | `AGENT_MAX_SOL_PER_TX` + `balance > 0.02` pre-trade gate |
| Compromised agent process | Cross-agent attack | Each agent has separate keypair (no shared keys) |
| Rogue co-signer | Unauthorized multi-sig | Only `authorizedSigners` list can co-sign proposals |
| Passphrase brute-force | Key decryption | 210,000 PBKDF2 iterations + unique 32-byte salt per wallet |
| Replay attack | Re-executing old tx | `recentBlockhash` expires after ~2 minutes |
| Tampered wallet file | Silent key corruption | AES-GCM auth tag detects any modification |

### 7.2 LLM-Specific Security

Claude's output is treated as **untrusted user input** — validated before execution:

```
LLM output → validation layer → execution
                ↓
  action not in [IDLE,TRADE,YIELD,REBAL] → IDLE
  tradeAmount > MAX_SOL_PER_TX → cap to limit
  balance - tradeAmount < 0.003 → IDLE
  API timeout/error → rule-based fallback
```

The LLM cannot:
- Access private keys
- Craft arbitrary transactions
- Execute operations outside the four defined states
- Exceed per-transaction spend limits

### 7.3 What This Prototype Does Not Implement

For devnet demonstration the following are accepted simplifications:

| Feature | Devnet Approach | Production Requirement |
|---------|----------------|----------------------|
| Key storage | Encrypted files | HSM / AWS KMS / TEE |
| Multi-sig execution | In-memory | Squads Protocol (on-chain) |
| Passphrase source | Environment variable | Secrets manager (HashiCorp Vault) |
| LLM output validation | Rule checks | Formal constraint solver + human review |
| Rate limiting | None | Exponential back-off + circuit breaker |
| Slippage protection | None | Jupiter slippage tolerance + price oracle |

---

## 8. Scalability

### 8.1 Current Architecture

```
1 Node.js process
  ├── Agent 1: WalletManager + DecisionEngine + AgentRunner + timer
  ├── Agent 2: WalletManager + DecisionEngine + AgentRunner + timer
  └── Agent N: WalletManager + DecisionEngine + AgentRunner + timer
       ↓                          ↓
  Shared: Connection (1 Solana RPC connection)
  Shared: DeFiProtocol (stateless)
  Independent: Wallet files, FSM state, event listeners
```

### 8.2 Performance Benchmarks

Run `npm run benchmark` to measure on your system. Representative results on a standard laptop against devnet:

| Metric | Typical Value |
|--------|--------------|
| Wallet creation | 300–1500ms (dominated by optional airdrop) |
| Wallet load (decrypt) | 2–10ms |
| Balance query | 200–800ms (devnet RPC latency) |
| Decision cycle (rule-based) | 250–900ms |
| Decision cycle (LLM) | 1200–4000ms (Claude API + RPC) |
| Concurrent agent throughput | 3–10 agent-decisions/sec |

### 8.3 Horizontal Scaling

```
Machine 1: process A (agents 1–10)  ─┐
Machine 2: process B (agents 11–20) ─┼─► Solana devnet (coordination layer)
Machine 3: process C (agents 21–30) ─┘
```

Agents in different processes communicate only through on-chain transactions. No synchronisation, no shared state, no distributed lock needed.

### 8.4 Bottlenecks

| Bottleneck | Root Cause | Mitigation |
|-----------|-----------|-----------|
| Devnet RPC rate limits | Public endpoint throttling | Dedicated RPC node (Helius, QuickNode) |
| Claude API latency | Network + inference time | Batch decisions, use claude-haiku |
| Devnet airdrop rate limit | Faucet throttling | Pre-fund wallets, retry with back-off |
| Node.js single thread | CPU-bound LLM parsing | Worker threads for decision logic |

---

## 9. How AI Agents Interact with Wallets

The separation of concerns is strict and enforced by design:

```
┌──────────────────────────────────────────────────────────────┐
│  AI Agent Layer (DecisionEngine / LLMDecisionEngine)         │
│                                                              │
│  Sees:  wallet.publicKey, wallet.getSOLBalance()             │
│         wallet.getTokenBalance(), wallet.sendSOL()           │
│         wallet.signAndSend()                                 │
│                                                              │
│  Does NOT see:  _keypair, secretKey, encryptedSecret         │
└────────────────────────────────┬─────────────────────────────┘
                                 │  public API only
┌────────────────────────────────▼─────────────────────────────┐
│  WalletManager (security boundary)                           │
│                                                              │
│  Holds internally:  _keypair.secretKey ← never crosses up   │
│  Performs:  PBKDF2 derivation, AES-GCM decrypt, Ed25519 sign │
└────────────────────────────────┬─────────────────────────────┘
                                 │  RPC
┌────────────────────────────────▼─────────────────────────────┐
│  Solana Network (devnet / mainnet)                           │
└──────────────────────────────────────────────────────────────┘
```

An AI agent — whether rule-based, LLM-driven, or RL-trained — is a decision function that maps `(balance, cycle, peers, LLM_inference) → action`. The wallet layer is an implementation detail the agent never reasons about.

This abstraction is correct: **the agent knows what it wants to do; the wallet knows how to do it safely.**

---

## 10. Extending to Production (Mainnet)

Nine-point checklist for production readiness:

| # | Change | Why |
|---|--------|-----|
| 1 | `SOLANA_NETWORK=mainnet-beta` + paid RPC | Live funds |
| 2 | `AUTO_AIRDROP=false` | No mainnet faucet |
| 3 | Move `WALLET_PASSPHRASE` to AWS KMS | Secrets management |
| 4 | Wrap `WalletManager` with SGX/Nitro TEE | Hardware key protection |
| 5 | Replace in-memory multi-sig with Squads Protocol | On-chain governance |
| 6 | Add Jupiter slippage + price oracle checks | DEX safety |
| 7 | Add RPC exponential back-off + circuit breaker | Reliability |
| 8 | Add LLM output formal verification | AI safety |
| 9 | Deploy in isolated containers with network policy | Blast radius |

---

## 11. Resources

- [Solana Web3.js Docs](https://solana-labs.github.io/solana-web3.js/)
- [SPL Token Program](https://spl.solana.com/token)
- [Solana Memo Program](https://spl.solana.com/memo)
- [Solana JSON RPC API](https://solana.com/docs/rpc)
- [Jupiter Aggregator V6 API](https://station.jup.ag/docs/apis/swap-api)
- [Squads Multi-sig Protocol](https://squads.so/protocol)
- [Anthropic Claude API](https://docs.anthropic.com/en/api)
- [Solana Devnet Faucet](https://faucet.solana.com/)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [NIST AES-GCM Specification](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf)
