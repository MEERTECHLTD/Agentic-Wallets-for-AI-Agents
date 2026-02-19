/**
 * LLMDecisionEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop-in replacement for the rule-based DecisionEngine that uses the
 * Anthropic Claude API (claude-haiku-4-5 by default – fast + cheap) as the
 * "brain" of the agent.
 *
 * The agent receives a structured JSON prompt describing its current portfolio
 * state, available actions, and peer balances.  Claude returns a decision
 * object that is validated and executed.
 *
 * Fallback: if the API call fails (network error, quota, etc.) the engine
 * transparently falls back to the rule-based _fallbackDecide() so agents
 * never get stuck.
 *
 * Usage:
 *   import { LLMDecisionEngine } from "./LLMDecisionEngine.js";
 *   // Identical API to DecisionEngine – just swap the class.
 *
 * Requires env var:
 *   ANTHROPIC_API_KEY=sk-ant-...
 */

import { DecisionEngine, AgentState } from "./DecisionEngine.js";
import { AGENT_MAX_SOL_PER_TX } from "../config.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

/**
 * System prompt injected into every LLM request.
 * Structured to give the model clear constraints and a valid output schema.
 */
const SYSTEM_PROMPT = `You are an autonomous AI agent managing a Solana wallet on devnet.
Your goal is to make smart decisions to grow your portfolio, maintain liquidity, and trade with peers.

You will receive a JSON snapshot of your current state.
Respond ONLY with a valid JSON object in this exact format:
{
  "action": "IDLE" | "TRADE" | "YIELD" | "REBAL",
  "reason": "<one sentence explaining your decision>",
  "tradeTarget": "<agentId of the peer to trade with, or null>",
  "tradeAmount": <SOL amount as float, or null>
}

Rules:
- IDLE: do nothing this cycle
- TRADE: transfer SOL to a peer (requires tradeTarget and tradeAmount ≤ ${AGENT_MAX_SOL_PER_TX})
- YIELD: log a simulated yield event on-chain
- REBAL: trigger a pool rebalance across all agents
- Never trade more than ${AGENT_MAX_SOL_PER_TX} SOL in a single transaction
- Never trade if your balance would drop below 0.003 SOL
- Prefer TRADE when peers have significantly lower balances than you
- Prefer IDLE when your balance is below 0.01 SOL
- Use REBAL sparingly (at most every 10 cycles)`;

export class LLMDecisionEngine extends DecisionEngine {
  /**
   * @param {string} agentId
   * @param {WalletManager} walletManager
   * @param {DeFiProtocol} protocol
   * @param {WalletManager[]} peerWallets
   */
  constructor(agentId, walletManager, protocol, peerWallets = []) {
    super(agentId, walletManager, protocol, peerWallets);
    this._apiKey = process.env.ANTHROPIC_API_KEY;
    this._lastLLMDecision = null;
    this._llmCallCount = 0;
    this._llmFailCount = 0;
  }

  // ─── Override core tick to inject LLM decision ────────────────────────────

  async tick() {
    this.cycleCount++;
    const balance = await this.wallet.getSOLBalance();

    // Hard safety gate – never go below rent threshold regardless of LLM
    if (balance < 0.003) {
      this.state = AgentState.IDLE;
      this.log.info(`Cycle ${this.cycleCount} | bal=${balance.toFixed(4)} | forced IDLE (low balance)`);
      this.emit("decision", {
        agentId: this.agentId, cycle: this.cycleCount, balance,
        prevState: this.state, nextState: AgentState.IDLE,
        source: "safety-gate",
      });
      return;
    }

    // Build state snapshot for LLM
    const peerSnapshots = await this._buildPeerSnapshots();
    const snapshot = {
      agentId: this.agentId,
      publicKey: this.wallet.publicKey,
      balanceSOL: parseFloat(balance.toFixed(6)),
      cycleNumber: this.cycleCount,
      tradeCount: this.tradeCount,
      totalVolumeSOL: parseFloat(this.totalVolume.toFixed(6)),
      peers: peerSnapshots,
      maxTradeSOL: AGENT_MAX_SOL_PER_TX,
      availablePeerIds: this.peers.map((p) => p.agentId),
    };

    // Get LLM decision (with fallback)
    const decision = await this._llmDecide(snapshot);
    this._lastLLMDecision = decision;

    const nextState = this._validateDecision(decision, balance);

    this.log.info(
      `Cycle ${this.cycleCount} | bal=${balance.toFixed(4)} SOL | ` +
      `LLM → ${nextState} | reason: "${decision.reason}"`
    );

    this.emit("decision", {
      agentId: this.agentId,
      cycle: this.cycleCount,
      balance,
      prevState: this.state,
      nextState,
      source: "llm",
      reason: decision.reason,
    });

    this.state = nextState;
    await this._executeStateWithLLMContext(balance, decision);
  }

  // ─── LLM API Call ─────────────────────────────────────────────────────────

  async _llmDecide(snapshot) {
    if (!this._apiKey) {
      this.log.warn("ANTHROPIC_API_KEY not set – using rule-based fallback");
      return this._fallbackDecisionObject(snapshot.balanceSOL);
    }

    this._llmCallCount++;

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "x-api-key": this._apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 256,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `Current agent state:\n${JSON.stringify(snapshot, null, 2)}\n\nWhat action should I take this cycle?`,
            },
          ],
        }),
        signal: AbortSignal.timeout(15_000), // 15s timeout
      });

      if (!response.ok) {
        throw new Error(`Anthropic API returned ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      const rawContent = data.content?.[0]?.text || "";

      // Parse JSON from model response
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in LLM response");

      const parsed = JSON.parse(jsonMatch[0]);
      this.log.info(`[LLM] ${CLAUDE_MODEL} decision: ${JSON.stringify(parsed)}`);
      return parsed;
    } catch (err) {
      this._llmFailCount++;
      this.log.warn(`LLM call failed (${this._llmFailCount}): ${err.message} – using fallback`);
      return this._fallbackDecisionObject(snapshot.balanceSOL);
    }
  }

  // ─── Validation / Safety Layer ────────────────────────────────────────────

  _validateDecision(decision, balance) {
    const validActions = Object.values(AgentState);
    if (!validActions.includes(decision.action)) {
      this.log.warn(`LLM returned invalid action "${decision.action}" – defaulting to IDLE`);
      return AgentState.IDLE;
    }

    // Safety: don't trade if balance would be dangerously low
    if (decision.action === AgentState.TRADE) {
      const tradeAmt = decision.tradeAmount || 0;
      if (balance - tradeAmt < 0.003) {
        this.log.warn(`LLM trade would drain wallet below 0.003 SOL – downgrading to IDLE`);
        return AgentState.IDLE;
      }
      if (tradeAmt > AGENT_MAX_SOL_PER_TX) {
        this.log.warn(`LLM trade amount ${tradeAmt} exceeds cap ${AGENT_MAX_SOL_PER_TX} – capping`);
        decision.tradeAmount = AGENT_MAX_SOL_PER_TX;
      }
    }

    return decision.action;
  }

  // ─── Execute with LLM-provided context ───────────────────────────────────

  async _executeStateWithLLMContext(balance, decision) {
    try {
      switch (this.state) {
        case AgentState.TRADE:
          await this._doLLMTrade(balance, decision);
          break;
        case AgentState.YIELD:
          await this._doYield(balance);
          break;
        case AgentState.REBAL:
          await this._doRebal();
          break;
        default:
          this.log.info(`Agent idle – reason: "${decision.reason}"`);
      }
    } catch (err) {
      this.log.error(`Error in LLM state ${this.state}: ${err.message}`);
      this.emit("error", { agentId: this.agentId, state: this.state, error: err.message });
      this.state = AgentState.IDLE;
    }
  }

  async _doLLMTrade(balance, decision) {
    // Use LLM-specified target if valid, otherwise pick randomly
    let targetPeer = null;

    if (decision.tradeTarget) {
      targetPeer = this.peers.find((p) => p.agentId === decision.tradeTarget);
    }
    if (!targetPeer && this.peers.length > 0) {
      targetPeer = this.peers[Math.floor(Math.random() * this.peers.length)];
    }
    if (!targetPeer) return;

    const amount = parseFloat(
      Math.min(
        decision.tradeAmount || (Math.random() * AGENT_MAX_SOL_PER_TX),
        AGENT_MAX_SOL_PER_TX,
        balance * 0.1
      ).toFixed(6)
    );

    if (amount <= 0.000_001) return;

    this.log.info(
      `[LLM-TRADE] ${amount} SOL → ${targetPeer.agentId} | reason: "${decision.reason}"`
    );

    const sig = await this.protocol.executeTrade(
      this.wallet,
      targetPeer.publicKeyObj,
      amount
    );

    this.tradeCount++;
    this.totalVolume += amount;

    this.emit("action", {
      agentId: this.agentId,
      action: "TRADE",
      amount,
      target: targetPeer.agentId,
      signature: sig,
      source: "llm",
      reason: decision.reason,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async _buildPeerSnapshots() {
    return Promise.all(
      this.peers.map(async (p) => {
        try {
          const bal = await p.getSOLBalance();
          return { agentId: p.agentId, balanceSOL: parseFloat(bal.toFixed(6)) };
        } catch {
          return { agentId: p.agentId, balanceSOL: null };
        }
      })
    );
  }

  _fallbackDecisionObject(balance) {
    if (balance < 0.003) return { action: "IDLE", reason: "Balance too low", tradeTarget: null, tradeAmount: null };
    if (this.cycleCount % 7 === 0) return { action: "YIELD", reason: "Periodic yield cycle", tradeTarget: null, tradeAmount: null };
    if (this.cycleCount % 12 === 0 && this.peers.length > 0) return { action: "REBAL", reason: "Periodic rebalance", tradeTarget: null, tradeAmount: null };
    if (this.peers.length > 0 && balance > 0.02) {
      const peer = this.peers[Math.floor(Math.random() * this.peers.length)];
      return { action: "TRADE", reason: "Rule-based trade opportunity", tradeTarget: peer.agentId, tradeAmount: AGENT_MAX_SOL_PER_TX * 0.5 };
    }
    return { action: "IDLE", reason: "No opportunity found", tradeTarget: null, tradeAmount: null };
  }

  getStats() {
    return {
      ...super.getStats(),
      llmCalls: this._llmCallCount,
      llmFails: this._llmFailCount,
      lastDecision: this._lastLLMDecision,
      model: CLAUDE_MODEL,
    };
  }
}
