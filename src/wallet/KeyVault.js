/**
 * KeyVault.js
 * ─────────────────────────────────────────────────────────────────────────────
 * An in-process registry that maps agentId → WalletManager instances.
 * Acts as the single source of truth so no module accidentally creates
 * duplicate wallet objects for the same agent.
 *
 * Design principle: the vault holds the ONLY references to WalletManager
 * instances.  Agent logic receives only the public interface (publicKey,
 * balance queries, signAndSend), keeping private keys isolated.
 */

import { WalletManager } from "./WalletManager.js";
import { logger } from "../utils/logger.js";

export class KeyVault {
  constructor() {
    /** @type {Map<string, WalletManager>} */
    this._wallets = new Map();
  }

  /**
   * Register an agent: load existing wallet or create a new one.
   * @param {string} agentId
   * @returns {Promise<WalletManager>}
   */
  async register(agentId) {
    if (this._wallets.has(agentId)) {
      return this._wallets.get(agentId);
    }
    const wm = new WalletManager(agentId);
    await wm.getOrCreate();
    this._wallets.set(agentId, wm);
    logger.info(`KeyVault: registered wallet for ${agentId} (${wm.publicKey})`);
    return wm;
  }

  /**
   * Retrieve a registered wallet manager (throws if not found).
   * @param {string} agentId
   * @returns {WalletManager}
   */
  get(agentId) {
    const wm = this._wallets.get(agentId);
    if (!wm) throw new Error(`KeyVault: no wallet registered for agent ${agentId}`);
    return wm;
  }

  /** @returns {string[]} All registered agent IDs */
  agentIds() {
    return [...this._wallets.keys()];
  }

  /** @returns {number} */
  size() {
    return this._wallets.size;
  }
}

// Singleton vault shared across all modules in a process
export const globalVault = new KeyVault();
