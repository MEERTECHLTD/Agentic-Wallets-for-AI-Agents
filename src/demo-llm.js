/**
 * demo-llm.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Demonstrates the LLM-powered agent using the Anthropic Claude API.
 * Falls back to rule-based decisions if no API key is set.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node src/demo-llm.js
 *   # or without key (will use rule-based fallback):
 *   node src/demo-llm.js
 */

import "dotenv/config";
import chalk from "chalk";
import { WalletManager } from "./wallet/WalletManager.js";
import { DeFiProtocol } from "./defi/DeFiProtocol.js";
import { LLMDecisionEngine } from "./agent/LLMDecisionEngine.js";
import { JupiterClient, TOKENS } from "./defi/JupiterClient.js";

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

async function main() {
  console.clear();
  console.log(chalk.bold.cyan(`
╔══════════════════════════════════════════════════════════════╗
║   LLM-Powered Agentic Wallet Demo                            ║
║   AI Engine: Claude (Anthropic)                              ║
║   Network: Solana Devnet                                     ║
╚══════════════════════════════════════════════════════════════╝
`));

  if (!HAS_KEY) {
    console.log(chalk.yellow(
      "  ⚠  ANTHROPIC_API_KEY not set.\n" +
      "     The agent will use the rule-based fallback decision engine.\n" +
      "     Set ANTHROPIC_API_KEY in .env to enable full LLM mode.\n"
    ));
  } else {
    console.log(chalk.green(`  ✓ Anthropic API key detected – using Claude for agent decisions\n`));
  }

  const proto = new DeFiProtocol();
  const jupiter = new JupiterClient();

  // ── Create wallets ─────────────────────────────────────────────────────────
  console.log(chalk.yellow("▶ Step 1: Initialise LLM Agents"));
  const alice = new WalletManager("llm-alice");
  const bob = new WalletManager("llm-bob");
  await alice.getOrCreate();
  await bob.getOrCreate();
  console.log(chalk.green(`  ✓ Alice: ${alice.publicKey}`));
  console.log(chalk.green(`  ✓ Bob:   ${bob.publicKey}`));

  // ── Balances ───────────────────────────────────────────────────────────────
  console.log(chalk.yellow("\n▶ Step 2: Check Balances"));
  const aBal = await alice.getSOLBalance();
  const bBal = await bob.getSOLBalance();
  console.log(`  Alice: ${chalk.cyan(aBal.toFixed(4))} SOL`);
  console.log(`  Bob:   ${chalk.cyan(bBal.toFixed(4))} SOL`);

  // ── Jupiter Swap Simulation ────────────────────────────────────────────────
  console.log(chalk.yellow("\n▶ Step 3: Jupiter DEX Swap Simulation"));
  console.log(chalk.dim("  Fetching best route SOL → USDC from Jupiter API…"));
  if (aBal >= 0.001) {
    try {
      const swapResult = await jupiter.simulateSwap(
        alice,
        TOKENS.SOL,
        TOKENS.USDC,
        Math.floor(0.001 * 1e9) // 0.001 SOL in lamports
      );
      console.log(chalk.green(
        `  ✓ Swap simulated: 0.001 SOL → ~${(Number(swapResult.outAmount) / 1e6).toFixed(2)} USDC` +
        `  (priceImpact: ${swapResult.priceImpact}%)`
      ));
      if (swapResult.signature) {
        console.log(chalk.dim(`    Memo sig: ${swapResult.signature.slice(0, 20)}…`));
      }
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Swap simulation failed: ${err.message}`));
    }
  } else {
    console.log(chalk.dim("  ⚠ Insufficient balance for swap simulation"));
  }

  // ── LLM Decision Cycles ────────────────────────────────────────────────────
  console.log(chalk.yellow("\n▶ Step 4: LLM Autonomous Decision Cycles"));

  const aliceEngine = new LLMDecisionEngine("llm-alice", alice, proto, [bob]);
  const bobEngine = new LLMDecisionEngine("llm-bob", bob, proto, [alice]);

  for (const engine of [aliceEngine, bobEngine]) {
    engine.on("decision", (d) => {
      const src = d.source === "llm" ? chalk.magenta("[LLM]") : chalk.dim("[rule]");
      console.log(
        `  ${src} ${chalk.cyan(d.agentId)} → ${chalk.bold(d.nextState)}` +
        (d.reason ? chalk.dim(` | "${d.reason}"`) : "")
      );
    });
    engine.on("action", (a) => {
      if (a.action === "TRADE") {
        console.log(chalk.green(
          `  ✓ TRADE ${a.amount?.toFixed(4)} SOL ${a.agentId} → ${a.target}` +
          (a.signature ? chalk.dim(` | sig: ${a.signature.slice(0, 12)}…`) : "")
        ));
      }
    });
  }

  const CYCLES = 3;
  for (let i = 1; i <= CYCLES; i++) {
    console.log(chalk.bold(`\n  — Cycle ${i} / ${CYCLES} —`));
    await aliceEngine.tick();
    await bobEngine.tick();
    await sleep(500);
  }

  // ── Final Stats ────────────────────────────────────────────────────────────
  console.log(chalk.yellow("\n▶ Step 5: Final Stats"));
  for (const engine of [aliceEngine, bobEngine]) {
    const s = engine.getStats();
    const llmLine = s.llmCalls != null
      ? `  | LLM calls: ${s.llmCalls} (${s.llmFails} failed)`
      : "";
    console.log(
      `  ${s.agentId.padEnd(14)} cycles=${s.cycles} trades=${s.trades} ` +
      `vol=${s.volumeSOL.toFixed(4)} SOL${llmLine}`
    );
  }

  console.log(chalk.bold.cyan(`\n${"═".repeat(62)}`));
  console.log(chalk.bold.cyan(`  LLM Demo complete. All events on Solana devnet.`));
  if (HAS_KEY) {
    console.log(chalk.cyan(`  Agent decisions powered by Anthropic Claude.`));
  }
  console.log(chalk.bold.cyan(`${"═".repeat(62)}\n`));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => {
  console.error(chalk.red("Demo error:"), err.message);
  process.exit(1);
});
