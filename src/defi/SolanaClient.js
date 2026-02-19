/**
 * SolanaClient.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin wrapper around Solana devnet RPC calls needed by agents:
 *   • Latest blockhash
 *   • Slot / epoch info
 *   • Transaction status polling
 *   • Airdrop (devnet only)
 *
 * Keeps all RPC calls in one place so switching from devnet → mainnet only
 * requires changing the connection URL in config.js.
 */

import { getConnection } from "../config.js";
import { logger } from "../utils/logger.js";

export class SolanaClient {
  constructor() {
    this.conn = getConnection();
  }

  async getLatestBlockhash() {
    const { blockhash, lastValidBlockHeight } =
      await this.conn.getLatestBlockhash("confirmed");
    return { blockhash, lastValidBlockHeight };
  }

  async getSlot() {
    return this.conn.getSlot();
  }

  async getEpochInfo() {
    return this.conn.getEpochInfo();
  }

  /**
   * Wait for a transaction to be confirmed.
   * Returns true if confirmed within timeout, false otherwise.
   */
  async awaitConfirmation(signature, timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.conn.getSignatureStatus(signature);
      if (status?.value?.confirmationStatus === "confirmed" ||
          status?.value?.confirmationStatus === "finalized") {
        return true;
      }
      await sleep(2000);
    }
    logger.warn(`Transaction ${signature} not confirmed within ${timeoutMs}ms`);
    return false;
  }

  /** Fetch recent transaction signatures for a public key */
  async getRecentTransactions(publicKey, limit = 10) {
    return this.conn.getSignaturesForAddress(publicKey, { limit });
  }

  /** Get parsed transaction details */
  async getTransaction(signature) {
    return this.conn.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
