#!/usr/bin/env node
/**
 * observer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Interactive CLI that lets you observe, control, and inspect agentic wallets
 * running on Solana devnet in real time.
 *
 * Features
 * ─────────
 * • List all persisted agent wallets with live SOL balances
 * • Start / stop individual agents interactively
 * • Trigger one-off actions (airdrop, transfer, memo, rebalance)
 * • Live event feed from running agents
 *
 * Usage: node src/cli/observer.js
 */

import "dotenv/config";
import inquirer from "inquirer";
import chalk from "chalk";
import Table from "cli-table3";
import { WalletManager } from "../wallet/WalletManager.js";
import { AgentRunner } from "../agent/AgentRunner.js";
import { logger } from "../utils/logger.js";

const runners = new Map(); // agentId → AgentRunner

async function main() {
  console.clear();
  banner();
  await mainMenu();
}

function banner() {
  console.log(chalk.cyan.bold(`
╔══════════════════════════════════════════════════════╗
║        Agentic Wallet Observer  –  Solana Devnet     ║
║        Superteam Nigeria DeFi Developer Challenge    ║
╚══════════════════════════════════════════════════════╝
`));
}

async function mainMenu() {
  const { choice } = await inquirer.prompt([
    {
      type: "list",
      name: "choice",
      message: "What would you like to do?",
      choices: [
        { name: "📋  List all agent wallets", value: "list" },
        { name: "🆕  Create new agent wallet", value: "create" },
        { name: "▶   Start agent", value: "start" },
        { name: "⏹   Stop agent", value: "stop" },
        { name: "💧  Request airdrop", value: "airdrop" },
        { name: "💸  Send SOL between agents", value: "transfer" },
        { name: "📊  Live stats", value: "stats" },
        { name: "🚪  Exit", value: "exit" },
      ],
    },
  ]);

  switch (choice) {
    case "list":    await cmdList(); break;
    case "create":  await cmdCreate(); break;
    case "start":   await cmdStart(); break;
    case "stop":    await cmdStop(); break;
    case "airdrop": await cmdAirdrop(); break;
    case "transfer":await cmdTransfer(); break;
    case "stats":   await cmdStats(); break;
    case "exit":
      console.log(chalk.cyan("\nGoodbye!\n"));
      process.exit(0);
  }

  // Loop back
  await mainMenu();
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdList() {
  const ids = WalletManager.listAll();
  if (ids.length === 0) {
    console.log(chalk.yellow("\n  No wallets found. Create one first.\n"));
    return;
  }

  const table = new Table({
    head: [
      chalk.white("Agent ID"),
      chalk.white("Public Key"),
      chalk.white("SOL Balance"),
      chalk.white("Running"),
    ],
    style: { head: [], border: ["cyan"] },
  });

  for (const id of ids) {
    const wm = new WalletManager(id);
    try {
      wm.loadWallet();
      const bal = await wm.getSOLBalance();
      const running = runners.has(id) && runners.get(id).isRunning;
      table.push([
        id,
        wm.publicKey.slice(0, 16) + "…",
        chalk.yellow(bal.toFixed(4) + " SOL"),
        running ? chalk.green("YES") : chalk.dim("no"),
      ]);
    } catch {
      table.push([id, chalk.red("load error"), "—", "—"]);
    }
  }
  console.log("\n" + table.toString() + "\n");
}

async function cmdCreate() {
  const { agentId } = await inquirer.prompt([
    {
      type: "input",
      name: "agentId",
      message: "Enter agent ID (leave blank for auto-generated):",
      default: WalletManager.generateAgentId(),
    },
  ]);

  const wm = new WalletManager(agentId.trim());
  const result = await wm.createWallet().catch((err) => {
    console.log(chalk.red(`  Error: ${err.message}\n`));
    return null;
  });
  if (result) {
    console.log(chalk.green(`\n  Wallet created!\n  ID:  ${result.agentId}\n  Key: ${result.publicKey}\n`));
  }
}

async function cmdStart() {
  const ids = WalletManager.listAll();
  if (ids.length === 0) { console.log(chalk.yellow("\n  No wallets to start.\n")); return; }

  const { agentId } = await inquirer.prompt([
    { type: "list", name: "agentId", message: "Select agent to start:", choices: ids },
  ]);

  if (runners.has(agentId) && runners.get(agentId).isRunning) {
    console.log(chalk.yellow(`\n  ${agentId} is already running.\n`));
    return;
  }

  const peers = ids
    .filter((id) => id !== agentId)
    .map((id) => { const w = new WalletManager(id); w.loadWallet(); return w; });

  const runner = new AgentRunner(agentId, peers);
  await runner.init();
  runner.on("action", (a) =>
    console.log(chalk.cyan(`\n  [${a.agentId}] ${a.action}`) + (a.amount ? ` ${a.amount} SOL` : "") +
    (a.signature ? chalk.dim(` – ${a.signature.slice(0, 12)}…`) : ""))
  );
  runners.set(agentId, runner);

  const { interval } = await inquirer.prompt([
    { type: "number", name: "interval", message: "Tick interval (ms):", default: 20000 },
  ]);
  runner.start(interval);
  console.log(chalk.green(`\n  Agent ${agentId} started.\n`));
}

async function cmdStop() {
  const running = [...runners.entries()]
    .filter(([, r]) => r.isRunning)
    .map(([id]) => id);

  if (running.length === 0) { console.log(chalk.yellow("\n  No agents running.\n")); return; }

  const { agentId } = await inquirer.prompt([
    { type: "list", name: "agentId", message: "Select agent to stop:", choices: running },
  ]);
  runners.get(agentId).stop();
  console.log(chalk.green(`\n  Agent ${agentId} stopped.\n`));
}

async function cmdAirdrop() {
  const ids = WalletManager.listAll();
  if (ids.length === 0) { console.log(chalk.yellow("\n  No wallets.\n")); return; }

  const { agentId, amount } = await inquirer.prompt([
    { type: "list", name: "agentId", message: "Select agent:", choices: ids },
    { type: "number", name: "amount", message: "Amount SOL (devnet max 2):", default: 1 },
  ]);
  const wm = new WalletManager(agentId);
  wm.loadWallet();
  console.log(chalk.dim(`\n  Requesting ${amount} SOL airdrop…`));
  await wm.airdrop(amount);
  const bal = await wm.getSOLBalance();
  console.log(chalk.green(`  Done. New balance: ${bal.toFixed(4)} SOL\n`));
}

async function cmdTransfer() {
  const ids = WalletManager.listAll();
  if (ids.length < 2) { console.log(chalk.yellow("\n  Need at least 2 wallets.\n")); return; }

  const { from, to, amount } = await inquirer.prompt([
    { type: "list", name: "from", message: "From agent:", choices: ids },
    { type: "list", name: "to", message: "To agent:", choices: ids },
    { type: "number", name: "amount", message: "Amount SOL:", default: 0.001 },
  ]);

  if (from === to) { console.log(chalk.red("\n  Cannot send to self.\n")); return; }

  const wmFrom = new WalletManager(from); wmFrom.loadWallet();
  const wmTo = new WalletManager(to); wmTo.loadWallet();

  console.log(chalk.dim(`\n  Sending ${amount} SOL…`));
  try {
    const sig = await wmFrom.sendSOL(wmTo.publicKey, amount);
    console.log(chalk.green(`  Done. Sig: ${sig.slice(0, 20)}…\n`));
  } catch (err) {
    console.log(chalk.red(`  Error: ${err.message}\n`));
  }
}

async function cmdStats() {
  if (runners.size === 0) { console.log(chalk.yellow("\n  No agents started yet.\n")); return; }

  const table = new Table({
    head: [
      chalk.white("Agent"),
      chalk.white("State"),
      chalk.white("Cycles"),
      chalk.white("Trades"),
      chalk.white("Volume SOL"),
      chalk.white("Running"),
    ],
    style: { head: [], border: ["cyan"] },
  });

  for (const [, runner] of runners) {
    const s = runner.getStats();
    table.push([
      s.agentId,
      s.state,
      s.cycles,
      s.trades,
      s.volumeSOL.toFixed(6),
      s.running ? chalk.green("YES") : chalk.dim("no"),
    ]);
  }
  console.log("\n" + table.toString() + "\n");
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err);
  process.exit(1);
});
