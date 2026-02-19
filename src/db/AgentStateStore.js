/**
 * AgentStateStore.js – JSON-file-backed persistent state store for agent history.
 * No native dependencies required.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { logger } from "../utils/logger.js";

const DATA_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : "./data";
const STORE_FILE = path.join(DATA_DIR, "agent-state.json");

export class AgentStateStore {
  constructor() {
    this._state = { agents: {}, decisions: [], actions: [], swaps: [] };
    this._dirty = false;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      if (existsSync(STORE_FILE)) {
        this._state = JSON.parse(readFileSync(STORE_FILE, "utf8"));
        logger.info("AgentStateStore: loaded from " + STORE_FILE);
      } else {
        this._persist();
        logger.info("AgentStateStore: initialised at " + STORE_FILE);
      }
      setInterval(() => { if (this._dirty) this._persist(); }, 30_000);
    } catch (err) {
      logger.warn("AgentStateStore: init error – " + err.message);
    }
  }

  _persist() {
    try { writeFileSync(STORE_FILE, JSON.stringify(this._state, null, 2), "utf8"); this._dirty = false; }
    catch (err) { logger.warn("AgentStateStore persist failed: " + err.message); }
  }

  registerAgent(agentId, publicKey) {
    if (!this._state.agents[agentId]) {
      this._state.agents[agentId] = { agentId, publicKey, createdAt: Date.now(), network: "devnet" };
      this._dirty = true;
    }
  }

  logDecision(agentId, cycle, prevState, nextState, balanceSOL, reason = null, source = "rule") {
    this._state.decisions.push({ agentId, cycle, prevState, nextState, balanceSOL, reason, source, timestamp: Date.now() });
    this._dirty = true;
    if (this._state.decisions.length > 2000) this._state.decisions = this._state.decisions.slice(-2000);
  }

  logAction(agentId, action, amountSOL = null, targetAgentId = null, signature = null, source = "rule", reason = null) {
    this._state.actions.push({ agentId, action, amountSOL, targetAgentId, signature, source, reason, timestamp: Date.now() });
    this._dirty = true;
    if (this._state.actions.length > 2000) this._state.actions = this._state.actions.slice(-2000);
  }

  logSwap(agentId, inputMint, outputMint, inAmount, outAmount, priceImpact, signature, simulated = true) {
    this._state.swaps.push({ agentId, inputMint, outputMint, inAmount, outAmount, priceImpact, signature, simulated, timestamp: Date.now() });
    this._dirty = true;
  }

  getAgentHistory(agentId, limit = 50) {
    return {
      decisions: this._state.decisions.filter((d) => d.agentId === agentId).slice(-limit),
      actions: this._state.actions.filter((a) => a.agentId === agentId).slice(-limit),
    };
  }

  getAgentStats(agentId) {
    const decs = this._state.decisions.filter((d) => d.agentId === agentId);
    const trades = this._state.actions.filter((a) => a.agentId === agentId && a.action === "TRADE");
    const bals = decs.map((d) => d.balanceSOL).filter((b) => b != null);
    return {
      totalCycles: decs.length,
      tradeDecisions: decs.filter((d) => d.nextState === "TRADE").length,
      avgBalance: bals.length ? bals.reduce((a, b) => a + b, 0) / bals.length : 0,
      minBalance: bals.length ? Math.min(...bals) : 0,
      maxBalance: bals.length ? Math.max(...bals) : 0,
      totalVolume: trades.reduce((s, a) => s + (a.amountSOL || 0), 0),
      tradeCount: trades.length,
    };
  }

  getAllAgents() { return Object.values(this._state.agents); }
  getRecentActions(limit = 100) { return this._state.actions.slice(-limit).reverse(); }
  getSwaps(agentId = null, limit = 50) {
    const s = agentId ? this._state.swaps.filter((x) => x.agentId === agentId) : this._state.swaps;
    return s.slice(-limit).reverse();
  }
  flush() { this._persist(); }
}

let _store = null;
export function getStore() { if (!_store) _store = new AgentStateStore(); return _store; }
