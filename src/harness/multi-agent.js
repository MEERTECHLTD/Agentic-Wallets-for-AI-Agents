/**
 * multi-agent.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Test harness: spawns N autonomous AI agent wallets and runs them concurrently
 * on Solana devnet.  Every agent manages its own wallet, makes independent
 * decisions, and interacts with the DeFiProtocol layer.
 *
 * Usage:
 *   node src/harness/multi-agent.js [agentCount] [durationSeconds]
 *
 * Example:
 *   node src/harness/multi-agent.js 3 120
 */

import "dotenv/config";
import { AgentRunner } from "../agent/AgentRunner.js";
import { WalletManager } from "../wallet/WalletManager.js";
import { logger } from "../utils/logger.js";

const AGENT_COUNT = parseInt(process.argv[2] || process.env.AGENT_COUNT || "3");
const DURATION_S = parseInt(process.argv[3] || "180");
const TICK_MS = parseInt(process.env.AGENT_DECISION_INTERVAL_MS || "20000");

async function main() {
  logger.info(`\n${"═".repeat(60)}`);
  logger.info(`  Agentic Wallets – Multi-Agent Harness`);
  logger.info(`  Agents: ${AGENT_COUNT}  |  Duration: ${DURATION_S}s  |  Tick: ${TICK_MS}ms`);
  logger.info(`${"═".repeat(60)}\n`);

  // ── 1. Create agent IDs ────────────────────────────────────────────────────
  const agentIds = Array.from({ length: AGENT_COUNT }, (_, i) =>
    `agent-${String(i + 1).padStart(2, "0")}`
  );

  // ── 2. Initialise all runners (wallets created/loaded in parallel) ─────────
  logger.info("Initialising agents…");
  const runners = await Promise.all(
    agentIds.map((id) => new AgentRunner(id).init())
  );

  // ── 3. Wire up peer references (each agent knows all others' wallets) ──────
  const allWallets = runners.map((r) => r.wallet);
  for (const runner of runners) {
    const peers = allWallets.filter((w) => w.agentId !== runner.agentId);
    runner.setPeers(peers);
  }

  // ── 4. Subscribe to events for consolidated logging ───────────────────────
  for (const runner of runners) {
    runner.on("action", (a) => {
      const tag = `[${a.agentId}]`;
      if (a.action === "TRADE") {
        logger.info(`${tag} TRADE ${a.amount} SOL → ${a.target} | sig: ${a.signature?.slice(0, 12)}…`);
      } else if (a.action === "YIELD") {
        logger.info(`${tag} YIELD simulated ${a.yieldSOL} SOL | sig: ${a.signature?.slice(0, 12) ?? "n/a"}…`);
      } else if (a.action === "REBAL") {
        logger.info(`${tag} REBAL triggered | target: ${a.targetBalance?.toFixed(4)} SOL`);
      }
    });
    runner.on("error", (e) => {
      logger.error(`[${e.agentId}] ERROR in ${e.state}: ${e.error}`);
    });
  }

  // ── 5. Start all agents ───────────────────────────────────────────────────
  logger.info(`\nStarting ${AGENT_COUNT} agents…\n`);
  for (const runner of runners) {
    runner.start(TICK_MS);
  }

  // ── 6. Print live stats every 30 seconds ─────────────────────────────────
  const statsInterval = setInterval(() => {
    printStats(runners);
  }, 30_000);

  // ── 7. Graceful shutdown after DURATION_S ────────────────────────────────
  await new Promise((resolve) => setTimeout(resolve, DURATION_S * 1_000));

  clearInterval(statsInterval);
  logger.info("\nShutting down agents…");
  for (const runner of runners) runner.stop();

  // Final stats
  await new Promise((r) => setTimeout(r, 500));
  printStats(runners);
  logger.info("\nHarness complete.");
  process.exit(0);
}

function printStats(runners) {
  logger.info("\n" + "─".repeat(60));
  logger.info("  AGENT STATS SNAPSHOT");
  logger.info("─".repeat(60));
  for (const r of runners) {
    const s = r.getStats();
    logger.info(
      `  ${s.agentId.padEnd(12)} | ${s.publicKey.slice(0, 8)}… | ` +
      `state: ${s.state.padEnd(5)} | cycles: ${String(s.cycles).padStart(3)} | ` +
      `trades: ${String(s.trades).padStart(3)} | vol: ${s.volumeSOL.toFixed(4)} SOL`
    );
  }
  logger.info("─".repeat(60) + "\n");
}

main().catch((err) => {
  logger.error("Fatal harness error:", err);
  process.exit(1);
});
