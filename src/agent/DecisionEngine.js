/**
 * DecisionEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Autonomous decision-making core for an AI agent.
 *
 * Architecture
 * ─────────────
 * Each agent runs a finite-state machine with four states:
 *
 *   IDLE   → agent is resting; may scan for opportunities
 *   TRADE  → agent has decided to execute a SOL transfer/swap
 *   YIELD  → agent is claiming/logging simulated yield
 *   REBAL  → agent is triggering a pool rebalance
 *
 * Decision logic is intentionally simple rule-based AI (no external LLM
 * dependency) so the prototype runs fully on-chain on devnet without API keys.
 * The architecture is plug-in ready: replace `decide()` with an LLM call.
 *
 * The engine emits events consumed by the CLI observer:
 *   "decision"  { agentId, state, reason, data }
 *   "action"    { agentId, action, signature }
 *   "error"     { agentId, error }
 */

import EventEmitter from "eventemitter3";
import { AGENT_MAX_SOL_PER_TX } from "../config.js";
import { logger, agentLogger } from "../utils/logger.js";

// Finite-state names
export const AgentState = Object.freeze({
  IDLE: "IDLE",
  TRADE: "TRADE",
  YIELD: "YIELD",
  REBAL: "REBAL",
});

export class DecisionEngine extends EventEmitter {
  /**
   * @param {string} agentId
   * @param {WalletManager} walletManager
   * @param {DeFiProtocol} protocol
   * @param {WalletManager[]} [peerWallets] – other agents in the pool
   */
  constructor(agentId, walletManager, protocol, peerWallets = []) {
    super();
    this.agentId = agentId;
    this.wallet = walletManager;
    this.protocol = protocol;
    this.peers = peerWallets;
    this.state = AgentState.IDLE;
    this.log = agentLogger(agentId);
    this.cycleCount = 0;
    this.tradeCount = 0;
    this.totalVolume = 0;
  }

  // ─── Core Decision Loop ──────────────────────────────────────────────────

  /**
   * Run one decision cycle.  Called on a timer by AgentRunner.
   */
  async tick() {
    this.cycleCount++;
    const balance = await this.wallet.getSOLBalance();
    const nextState = this._decide(balance);

    this.log.info(
      `Cycle ${this.cycleCount} | bal=${balance.toFixed(4)} SOL | ` +
      `${this.state} → ${nextState}`
    );

    this.emit("decision", {
      agentId: this.agentId,
      cycle: this.cycleCount,
      balance,
      prevState: this.state,
      nextState,
    });

    this.state = nextState;
    await this._executeState(balance);
  }

  // ─── Rule-Based Decision Logic (replace with LLM for production) ─────────

  /**
   * Given the current SOL balance, determine the next action.
   * Rules (priority order):
   *   1. If balance < 0.003 SOL → IDLE (too low to act safely)
   *   2. Every 7th cycle → YIELD simulation
   *   3. Every 12th cycle → trigger REBAL
   *   4. If a peer has significantly less balance → TRADE (altruistic transfer)
   *   5. Otherwise → IDLE
   */
  _decide(balance) {
    if (balance < 0.003) return AgentState.IDLE;
    if (this.cycleCount % 7 === 0) return AgentState.YIELD;
    if (this.cycleCount % 12 === 0 && this.peers.length > 0) return AgentState.REBAL;

    // Scan peers for trade opportunity
    if (this.peers.length > 0 && balance > 0.02) {
      return AgentState.TRADE;
    }
    return AgentState.IDLE;
  }

  // ─── State Execution ─────────────────────────────────────────────────────

  async _executeState(balance) {
    try {
      switch (this.state) {
        case AgentState.TRADE:
          await this._doTrade(balance);
          break;
        case AgentState.YIELD:
          await this._doYield(balance);
          break;
        case AgentState.REBAL:
          await this._doRebal();
          break;
        case AgentState.IDLE:
        default:
          this.log.info("Agent idle – scanning for opportunities…");
          break;
      }
    } catch (err) {
      this.log.error(`Error in state ${this.state}: ${err.message}`);
      this.emit("error", { agentId: this.agentId, state: this.state, error: err.message });
      this.state = AgentState.IDLE; // fall back to safe state
    }
  }

  async _doTrade(balance) {
    if (this.peers.length === 0) {
      this.log.warn("No peers available for trade.");
      return;
    }
    // Pick a random peer
    const peer = this.peers[Math.floor(Math.random() * this.peers.length)];
    if (peer.agentId === this.agentId) return;

    // Clamp trade size
    const maxTrade = Math.min(AGENT_MAX_SOL_PER_TX, balance * 0.1);
    if (maxTrade < 0.000_001) return;

    const amount = parseFloat((Math.random() * maxTrade).toFixed(6));
    if (amount <= 0) return;

    this.log.info(`Trading ${amount} SOL → ${peer.agentId}`);
    const sig = await this.protocol.executeTrade(
      this.wallet,
      peer.publicKeyObj,
      amount
    );
    this.tradeCount++;
    this.totalVolume += amount;
    this.emit("action", {
      agentId: this.agentId,
      action: "TRADE",
      amount,
      target: peer.agentId,
      signature: sig,
    });
  }

  async _doYield(balance) {
    const yieldAmount = parseFloat((balance * 0.001).toFixed(6)); // 0.1% simulated yield
    const sig = await this.protocol.simulateYield(this.wallet, yieldAmount);
    this.emit("action", {
      agentId: this.agentId,
      action: "YIELD",
      yieldAmount,
      signature: sig,
    });
  }

  async _doRebal() {
    const allWallets = [this.wallet, ...this.peers];
    const balances = await Promise.all(allWallets.map((w) => w.getSOLBalance()));
    const avg = balances.reduce((a, b) => a + b, 0) / balances.length;
    this.log.info(`Triggering rebalance – pool avg: ${avg.toFixed(4)} SOL`);
    await this.protocol.rebalancePool(allWallets, avg);
    this.emit("action", {
      agentId: this.agentId,
      action: "REBAL",
      targetBalance: avg,
    });
  }

  // ─── Stats ───────────────────────────────────────────────────────────────

  getStats() {
    return {
      agentId: this.agentId,
      publicKey: this.wallet.publicKey,
      state: this.state,
      cycles: this.cycleCount,
      trades: this.tradeCount,
      volumeSOL: this.totalVolume,
    };
  }
}
