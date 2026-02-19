/**
 * benchmark.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Performance benchmark harness for the agentic wallet system.
 *
 * Measures:
 *   1. Wallet creation latency (N wallets, time per creation)
 *   2. Balance query throughput (queries per second against devnet RPC)
 *   3. Transaction submission latency (SOL transfer → confirmed)
 *   4. Decision cycle latency (time for one agent tick)
 *   5. Multi-agent concurrency (N agents, M cycles, total elapsed)
 *
 * Usage:
 *   node src/harness/benchmark.js [--agents 3] [--cycles 5]
 *
 * Output:
 *   Formatted results table with mean/median/p95/p99 latencies.
 */

import "dotenv/config";
import { unlinkSync, existsSync } from "fs";
import chalk from "chalk";
import Table from "cli-table3";
import { WalletManager } from "../wallet/WalletManager.js";
import { DeFiProtocol } from "../defi/DeFiProtocol.js";
import { DecisionEngine } from "../agent/DecisionEngine.js";

// Parse CLI args
const args = process.argv.slice(2);
const AGENTS = parseInt(getArg(args, "--agents") || "3");
const CYCLES = parseInt(getArg(args, "--cycles") || "5");
const WARMUP = 1; // warmup cycles to skip in latency measurements

function getArg(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const results = {};

async function main() {
  console.log(chalk.bold.cyan(`
╔══════════════════════════════════════════════════════════╗
║   Agentic Wallet Benchmark – Solana Devnet               ║
║   Agents: ${String(AGENTS).padEnd(3)} | Cycles: ${String(CYCLES).padEnd(3)} | ${new Date().toISOString().slice(0,10)} ║
╚══════════════════════════════════════════════════════════╝
`));

  // ── Benchmark 1: Wallet Creation ─────────────────────────────────────────
  await runBench("wallet_creation", `Create ${AGENTS} wallets`, async () => {
    const timings = [];
    for (let i = 0; i < AGENTS; i++) {
      const id = `bench-${Date.now()}-${i}`;
      const t0 = performance.now();
      const wm = new WalletManager(id);
      await wm.createWallet();
      timings.push(performance.now() - t0);
      cleanupWallet(id);
    }
    return timings;
  });

  // ── Benchmark 2: Wallet Load (decrypt) ───────────────────────────────────
  const benchIds = [];
  const benchWallets = [];
  for (let i = 0; i < AGENTS; i++) {
    const id = `bench-load-${i}`;
    const wm = new WalletManager(id);
    await wm.getOrCreate();
    benchIds.push(id);
    benchWallets.push(wm);
  }

  await runBench("wallet_load", `Load ${AGENTS} wallets from disk`, async () => {
    const timings = [];
    for (const id of benchIds) {
      const t0 = performance.now();
      const wm = new WalletManager(id);
      wm.loadWallet();
      timings.push(performance.now() - t0);
    }
    return timings;
  });

  // ── Benchmark 3: Balance Query Throughput ────────────────────────────────
  await runBench("balance_query", `Query balance for ${AGENTS} wallets`, async () => {
    const timings = [];
    for (const wm of benchWallets) {
      const t0 = performance.now();
      await wm.getSOLBalance();
      timings.push(performance.now() - t0);
    }
    return timings;
  });

  // ── Benchmark 4: Decision Cycle Latency ──────────────────────────────────
  const proto = new DeFiProtocol();
  await runBench("decision_cycle", `Decision tick (${CYCLES} cycles per agent)`, async () => {
    const timings = [];
    for (const wm of benchWallets) {
      const engine = new DecisionEngine(wm.agentId, wm, proto, []);
      for (let c = 0; c < CYCLES; c++) {
        const t0 = performance.now();
        await engine.tick();
        const elapsed = performance.now() - t0;
        if (c >= WARMUP) timings.push(elapsed);
      }
    }
    return timings;
  });

  // ── Benchmark 5: Concurrent Multi-Agent ──────────────────────────────────
  await runBench("concurrent_agents", `${AGENTS} agents × ${CYCLES} cycles (concurrent)`, async () => {
    const allWallets = benchWallets;
    const engines = benchWallets.map(
      (wm) => new DecisionEngine(wm.agentId, wm, proto, allWallets.filter((w) => w !== wm))
    );

    const timings = [];
    for (let c = 0; c < CYCLES; c++) {
      const t0 = performance.now();
      await Promise.all(engines.map((e) => e.tick()));
      timings.push(performance.now() - t0);
    }
    return timings;
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────
  for (const id of benchIds) cleanupWallet(id);

  // ── Print Results ─────────────────────────────────────────────────────────
  printResults();
}

async function runBench(name, label, fn) {
  process.stdout.write(chalk.dim(`\n  ▶ ${label}… `));
  const t0 = performance.now();
  try {
    const timings = await fn();
    const elapsed = performance.now() - t0;
    results[name] = { label, timings, totalMs: elapsed };
    console.log(chalk.green(`done (${elapsed.toFixed(0)}ms)`));
  } catch (err) {
    results[name] = { label, timings: [], totalMs: 0, error: err.message };
    console.log(chalk.red(`FAILED: ${err.message}`));
  }
}

function printResults() {
  console.log(chalk.bold.cyan("\n\n  BENCHMARK RESULTS\n"));

  const table = new Table({
    head: [
      chalk.white("Benchmark"),
      chalk.white("N"),
      chalk.white("Total ms"),
      chalk.white("Mean ms"),
      chalk.white("Median ms"),
      chalk.white("P95 ms"),
      chalk.white("P99 ms"),
      chalk.white("Min ms"),
      chalk.white("Max ms"),
    ],
    style: { head: [], border: ["cyan"] },
    colWidths: [28, 5, 10, 9, 10, 9, 9, 9, 9],
  });

  for (const [, r] of Object.entries(results)) {
    if (r.error) {
      table.push([r.label, "-", "-", "-", "-", "-", "-", chalk.red("ERROR: " + r.error.slice(0, 20)), "-"]);
      continue;
    }
    const t = r.timings.sort((a, b) => a - b);
    const N = t.length;
    if (N === 0) { table.push([r.label, "0", r.totalMs.toFixed(0), "-", "-", "-", "-", "-", "-"]); continue; }

    const mean = (t.reduce((a, b) => a + b, 0) / N).toFixed(1);
    const median = t[Math.floor(N / 2)].toFixed(1);
    const p95 = t[Math.floor(N * 0.95)].toFixed(1);
    const p99 = t[Math.floor(N * 0.99)].toFixed(1);
    const min = t[0].toFixed(1);
    const max = t[N - 1].toFixed(1);

    table.push([
      r.label.slice(0, 26),
      N,
      r.totalMs.toFixed(0),
      mean,
      median,
      p95,
      p99,
      min,
      max,
    ]);
  }

  console.log(table.toString());

  // Summary
  const concRaw = results["concurrent_agents"];
  if (concRaw && concRaw.timings.length > 0) {
    const throughput = (AGENTS * CYCLES) / (concRaw.totalMs / 1000);
    console.log(chalk.bold(`\n  Concurrent throughput: ${chalk.cyan(throughput.toFixed(1))} agent-decisions/sec`));
    console.log(chalk.dim(`  (${AGENTS} agents × ${CYCLES} cycles in ${concRaw.totalMs.toFixed(0)}ms)\n`));
  }
}

function cleanupWallet(id) {
  try {
    const walletFile = `./wallets/${id}.wallet.enc`;
    if (existsSync(walletFile)) unlinkSync(walletFile);
  } catch { /* best-effort */ }
}

main().catch((err) => {
  console.error(chalk.red("Benchmark error:"), err);
  process.exit(1);
});
