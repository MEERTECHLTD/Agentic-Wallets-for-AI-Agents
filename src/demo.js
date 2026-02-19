/**
 * demo.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-contained, one-shot demonstration of agentic wallets.
 * Runs 2 agents through 3 decision cycles each, no user input required.
 *
 * Usage: node src/demo.js
 */

import "dotenv/config";
import chalk from "chalk";
import { WalletManager } from "./wallet/WalletManager.js";
import { DeFiProtocol } from "./defi/DeFiProtocol.js";
import { DecisionEngine } from "./agent/DecisionEngine.js";

function divider(label = "") {
  const line = "─".repeat(56);
  console.log(chalk.cyan(label ? `\n┌─ ${label} ${"─".repeat(51 - label.length)}` : `\n${line}`));
}

async function runDemo() {
  console.clear();
  console.log(chalk.bold.cyan(`
╔══════════════════════════════════════════════════════════╗
║   Agentic Wallets for AI Agents – Live Demo              ║
║   Superteam Nigeria DeFi Developer Challenge             ║
║   Network: Solana Devnet                                 ║
╚══════════════════════════════════════════════════════════╝
`));

  const proto = new DeFiProtocol();

  // ── Step 1: Create wallets ─────────────────────────────────────────────────
  divider("Step 1: Create Agent Wallets");
  const alice = new WalletManager("demo-alice");
  const bob = new WalletManager("demo-bob");

  await alice.getOrCreate();
  await bob.getOrCreate();

  console.log(chalk.green(`  ✓ Alice: ${alice.publicKey}`));
  console.log(chalk.green(`  ✓ Bob:   ${bob.publicKey}`));

  // ── Step 2: Check balances ─────────────────────────────────────────────────
  divider("Step 2: Query SOL Balances");
  let aBal = await alice.getSOLBalance();
  let bBal = await bob.getSOLBalance();
  console.log(`  Alice: ${chalk.yellow(aBal.toFixed(4))} SOL`);
  console.log(`  Bob:   ${chalk.yellow(bBal.toFixed(4))} SOL`);

  // ── Step 3: Run decision engines ───────────────────────────────────────────
  divider("Step 3: Autonomous Decision Cycles");
  const aliceEngine = new DecisionEngine("demo-alice", alice, proto, [bob]);
  const bobEngine = new DecisionEngine("demo-bob", bob, proto, [alice]);

  for (const engine of [aliceEngine, bobEngine]) {
    engine.on("action", (a) => {
      if (a.action === "TRADE") {
        console.log(chalk.magenta(
          `  [${a.agentId}] TRADE ${a.amount} SOL → ${a.target}` +
          (a.signature ? ` | sig: ${a.signature.slice(0, 12)}…` : "")
        ));
      } else if (a.action === "YIELD") {
        console.log(chalk.blue(`  [${a.agentId}] YIELD ${a.yieldSOL} SOL logged on-chain`));
      }
    });
  }

  const CYCLES = 3;
  for (let i = 1; i <= CYCLES; i++) {
    console.log(chalk.bold(`\n  — Cycle ${i} —`));
    await aliceEngine.tick();
    await bobEngine.tick();
    await sleep(1000);
  }

  // ── Step 4: Final balances ─────────────────────────────────────────────────
  divider("Step 4: Final Balances");
  aBal = await alice.getSOLBalance();
  bBal = await bob.getSOLBalance();
  console.log(`  Alice: ${chalk.yellow(aBal.toFixed(4))} SOL`);
  console.log(`  Bob:   ${chalk.yellow(bBal.toFixed(4))} SOL`);

  // ── Step 5: Stats ──────────────────────────────────────────────────────────
  divider("Step 5: Agent Stats");
  for (const engine of [aliceEngine, bobEngine]) {
    const s = engine.getStats();
    console.log(
      `  ${s.agentId.padEnd(14)} cycles=${s.cycles} trades=${s.trades} vol=${s.volumeSOL.toFixed(4)} SOL`
    );
  }

  console.log(chalk.bold.cyan(`\n${"═".repeat(60)}`));
  console.log(chalk.bold.cyan(`  Demo complete. All transactions on Solana devnet.`));
  console.log(chalk.bold.cyan(`${"═".repeat(60)}\n`));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

runDemo().catch((err) => {
  console.error(chalk.red("Demo error:"), err.message);
  process.exit(1);
});
