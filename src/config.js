/**
 * config.js
 * Central configuration – reads from environment variables with safe defaults.
 * All modules import from here so swapping devnet → mainnet is a one-liner.
 */

import { clusterApiUrl, Connection } from "@solana/web3.js";
import "dotenv/config";

export const NETWORK = process.env.SOLANA_NETWORK || "devnet";
export const RPC_URL =
  process.env.SOLANA_RPC_URL || clusterApiUrl(NETWORK);

/** Shared, lazily-created connection (commitment: confirmed) */
let _connection = null;
export function getConnection() {
  if (!_connection) {
    _connection = new Connection(RPC_URL, "confirmed");
  }
  return _connection;
}

export const WALLET_STORAGE_DIR =
  process.env.WALLET_STORAGE_DIR || "./wallets";

export const AUTO_AIRDROP =
  (process.env.AUTO_AIRDROP || "true") === "true";

export const AIRDROP_AMOUNT_SOL = parseFloat(
  process.env.AIRDROP_AMOUNT_SOL || "1"
);

export const AGENT_DECISION_INTERVAL_MS = parseInt(
  process.env.AGENT_DECISION_INTERVAL_MS || "15000"
);

export const AGENT_MAX_SOL_PER_TX = parseFloat(
  process.env.AGENT_MAX_SOL_PER_TX || "0.01"
);

export const LOG_LEVEL = process.env.LOG_LEVEL || "info";
export const LOG_FILE = process.env.LOG_FILE || "./logs/agent.log";
