/**
 * index.js – Public API surface
 *
 * Exports all key classes so external consumers can import directly.
 */

export { WalletManager } from "./wallet/WalletManager.js";
export { KeyVault, globalVault } from "./wallet/KeyVault.js";
export { MultiSigManager, MultiSigProposal, globalMultiSig } from "./wallet/MultiSigManager.js";
export { DecisionEngine, AgentState } from "./agent/DecisionEngine.js";
export { LLMDecisionEngine } from "./agent/LLMDecisionEngine.js";
export { AgentRunner } from "./agent/AgentRunner.js";
export { DeFiProtocol } from "./defi/DeFiProtocol.js";
export { JupiterClient, TOKENS } from "./defi/JupiterClient.js";
export { SolanaClient } from "./defi/SolanaClient.js";
export { AgentStateStore, getStore } from "./db/AgentStateStore.js";
export { getConnection, NETWORK, RPC_URL } from "./config.js";
export { logger, agentLogger } from "./utils/logger.js";
