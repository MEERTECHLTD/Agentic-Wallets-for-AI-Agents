/**
 * AgentRunner.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lifecycle manager for a single AI agent.
 *
 * Responsibilities
 * ─────────────────
 * • Bootstrap: create/load wallet, initialise protocol and decision engine
 * • Schedule recurring decision ticks
 * • Expose start / stop / status API to the harness and CLI
 *
 * One AgentRunner per agent.  The multi-agent harness spawns N runners.
 */

import { WalletManager } from "../wallet/WalletManager.js";
import { DeFiProtocol } from "../defi/DeFiProtocol.js";
import { DecisionEngine } from "./DecisionEngine.js";
import { AGENT_DECISION_INTERVAL_MS } from "../config.js";
import { agentLogger } from "../utils/logger.js";

export class AgentRunner {
  /**
   * @param {string} agentId
   * @param {WalletManager[]} [peerWallets] – set after all agents are created
   */
  constructor(agentId, peerWallets = []) {
    this.agentId = agentId;
    this.log = agentLogger(agentId);
    this._peerWallets = peerWallets;
    this._timer = null;
    this._running = false;

    // These are set during init()
    this.wallet = null;
    this.protocol = null;
    this.engine = null;
  }

  /**
   * Initialise wallet, protocol, and decision engine.
   * Must be called before start().
   */
  async init() {
    this.wallet = new WalletManager(this.agentId);
    await this.wallet.getOrCreate();

    this.protocol = new DeFiProtocol();

    this.engine = new DecisionEngine(
      this.agentId,
      this.wallet,
      this.protocol,
      this._peerWallets
    );

    // Bubble events up so the harness / CLI can listen on the runner
    this.engine.on("decision", (d) => this.emit("decision", d));
    this.engine.on("action", (a) => this.emit("action", a));
    this.engine.on("error", (e) => this.emit("error", e));

    this.log.info(`Initialised – wallet: ${this.wallet.publicKey}`);
    return this;
  }

  /** Set peer wallets after all agents have been initialised. */
  setPeers(peerWallets) {
    this._peerWallets = peerWallets;
    if (this.engine) this.engine.peers = peerWallets;
  }

  /**
   * Start the autonomous decision loop.
   * @param {number} [intervalMs] – override default interval
   */
  start(intervalMs = AGENT_DECISION_INTERVAL_MS) {
    if (this._running) return;
    this._running = true;
    this.log.info(`Starting agent loop (interval: ${intervalMs}ms)`);

    // Run immediately, then on interval
    this._runTick();
    this._timer = setInterval(() => this._runTick(), intervalMs);
  }

  async _runTick() {
    try {
      await this.engine.tick();
    } catch (err) {
      this.log.error(`Tick error: ${err.message}`);
    }
  }

  /** Stop the agent loop gracefully. */
  stop() {
    if (!this._running) return;
    clearInterval(this._timer);
    this._running = false;
    this.log.info("Agent stopped.");
  }

  get isRunning() {
    return this._running;
  }

  getStats() {
    return {
      ...this.engine?.getStats(),
      running: this._running,
    };
  }

  // Minimal EventEmitter shim so callers can do runner.on("action", ...)
  _listeners = {};
  on(event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
    return this;
  }
  emit(event, data) {
    (this._listeners[event] || []).forEach((fn) => fn(data));
  }
  off(event, fn) {
    this._listeners[event] = (this._listeners[event] || []).filter((f) => f !== fn);
  }
}
