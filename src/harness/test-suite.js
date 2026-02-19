/**
 * test-suite.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Automated test suite that exercises the core wallet and protocol APIs
 * against Solana devnet.  Prints PASS / FAIL for each check.
 *
 * Usage: node src/harness/test-suite.js
 */

import "dotenv/config";
import { WalletManager } from "../wallet/WalletManager.js";
import { DeFiProtocol } from "../defi/DeFiProtocol.js";
import chalk from "chalk";

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(chalk.green(`  ✓ PASS`) + `  ${label}` + (detail ? chalk.dim(` (${detail})`) : ""));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ FAIL`) + `  ${label}` + (detail ? chalk.dim(` (${detail})`) : ""));
    failed++;
  }
}

async function run() {
  console.log(chalk.bold("\n══════════════════════════════════════════════════"));
  console.log(chalk.bold("  Agentic Wallets – Test Suite  (Solana Devnet)"));
  console.log(chalk.bold("══════════════════════════════════════════════════\n"));

  const proto = new DeFiProtocol();

  // ── Test 1: Wallet creation ───────────────────────────────────────────────
  console.log(chalk.yellow("▶ Wallet Creation"));
  const wm1 = new WalletManager("test-alice");
  const wm2 = new WalletManager("test-bob");

  try {
    await wm1.createWallet();
    check("Alice wallet created", wm1.publicKey.length === 44, wm1.publicKey);
  } catch (e) {
    // Already exists from a prior run – try loading
    wm1.loadWallet();
    check("Alice wallet loaded (pre-existing)", wm1.publicKey.length === 44, wm1.publicKey);
  }

  try {
    await wm2.createWallet();
    check("Bob wallet created", wm2.publicKey.length === 44, wm2.publicKey);
  } catch {
    wm2.loadWallet();
    check("Bob wallet loaded (pre-existing)", wm2.publicKey.length === 44, wm2.publicKey);
  }

  // ── Test 2: PublicKey differs between wallets ─────────────────────────────
  console.log(chalk.yellow("\n▶ Key Uniqueness"));
  check("Alice ≠ Bob public key", wm1.publicKey !== wm2.publicKey);

  // ── Test 3: Balance query ────────────────────────────────────────────────
  console.log(chalk.yellow("\n▶ Balance Queries"));
  const bal1 = await wm1.getSOLBalance();
  const bal2 = await wm2.getSOLBalance();
  check("Alice balance is a number", typeof bal1 === "number");
  check("Bob balance is a number", typeof bal2 === "number");
  check("Alice balance ≥ 0", bal1 >= 0, `${bal1.toFixed(4)} SOL`);
  check("Bob balance ≥ 0", bal2 >= 0, `${bal2.toFixed(4)} SOL`);

  // ── Test 4: SOL transfer (only if Alice has funds) ────────────────────────
  console.log(chalk.yellow("\n▶ SOL Transfer"));
  if (bal1 >= 0.002) {
    try {
      const sig = await wm1.sendSOL(wm2.publicKey, 0.001);
      check("Transfer Alice→Bob succeeded", typeof sig === "string" && sig.length > 0, sig.slice(0, 16) + "…");
      const newBal2 = await wm2.getSOLBalance();
      check("Bob balance increased after transfer", newBal2 > bal2);
    } catch (err) {
      check("Transfer Alice→Bob succeeded", false, err.message);
    }
  } else {
    console.log(chalk.dim("  ⚠ Skipping transfer – Alice has insufficient funds (airdrop may still be pending)"));
  }

  // ── Test 5: SPL Token balance (non-existent mint → 0) ────────────────────
  console.log(chalk.yellow("\n▶ SPL Token Balance"));
  const fakeMint = "So11111111111111111111111111111111111111112"; // Wrapped SOL mint
  const tokenBal = await wm1.getTokenBalance(fakeMint);
  check("Token balance returns 0 for unknown ATA", tokenBal === 0);

  // ── Test 6: Memo logging ──────────────────────────────────────────────────
  console.log(chalk.yellow("\n▶ On-Chain Memo"));
  if (bal1 >= 0.001) {
    try {
      const sig = await proto.logMemo(wm1, "agentic-wallet-test-suite-v1");
      check("Memo tx confirmed", typeof sig === "string" && sig.length > 0, sig.slice(0, 16) + "…");
    } catch (err) {
      check("Memo tx confirmed", false, err.message);
    }
  } else {
    console.log(chalk.dim("  ⚠ Skipping memo – insufficient funds"));
  }

  // ── Test 7: WalletManager.listAll ────────────────────────────────────────
  console.log(chalk.yellow("\n▶ Wallet Enumeration"));
  const all = WalletManager.listAll();
  check("listAll returns array", Array.isArray(all));
  check("listAll includes test-alice", all.includes("test-alice"));
  check("listAll includes test-bob", all.includes("test-bob"));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(chalk.bold("\n──────────────────────────────────────────────────"));
  console.log(
    `  Results: ${chalk.green(passed + " passed")}  ${failed > 0 ? chalk.red(failed + " failed") : chalk.dim("0 failed")}`
  );
  console.log(chalk.bold("──────────────────────────────────────────────────\n"));

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(chalk.red("Fatal test error:"), err);
  process.exit(1);
});
