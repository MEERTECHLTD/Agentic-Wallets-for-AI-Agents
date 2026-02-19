/**
 * JupiterClient.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Jupiter Aggregator integration for on-chain token swaps.
 *
 * Jupiter is Solana's leading DEX aggregator that routes trades through the
 * best available liquidity pools (Raydium, Orca, Meteora, etc.).
 *
 * This module provides:
 *   1. getQuote()       – fetch best swap route & estimated output
 *   2. buildSwapTx()    – construct the swap Transaction object
 *   3. executeSwap()    – get quote → build tx → sign → broadcast
 *
 * Devnet Note:
 *   Jupiter's API targets mainnet liquidity pools. On devnet we implement a
 *   graceful mock that:
 *   a) Calls the real Jupiter quote API (works on mainnet mints)
 *   b) Falls back to a mock SOL transfer simulation when devnet mints are used
 *   This lets the code path run fully on devnet for demonstration without
 *   requiring funded mainnet accounts.
 *
 * References:
 *   https://station.jup.ag/docs/apis/swap-api
 */

import { Transaction, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { getConnection } from "../config.js";
import { logger } from "../utils/logger.js";

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";

// Well-known mainnet token mints for quote testing
export const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",      // Wrapped SOL
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",   // USDT
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",  // BONK
  JUP:  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",   // JUP
};

export class JupiterClient {
  constructor() {
    this.conn = getConnection();
  }

  /**
   * Fetch the best swap route from Jupiter.
   *
   * @param {string} inputMint    – Input token mint address
   * @param {string} outputMint   – Output token mint address
   * @param {number} inputAmount  – Amount in SMALLEST unit (lamports for SOL)
   * @param {number} [slippageBps] – Max slippage in basis points (default: 50 = 0.5%)
   * @returns {Promise<QuoteResponse>}
   */
  async getQuote(inputMint, outputMint, inputAmount, slippageBps = 50) {
    const url = new URL(JUPITER_QUOTE_API);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", String(inputAmount));
    url.searchParams.set("slippageBps", String(slippageBps));
    url.searchParams.set("onlyDirectRoutes", "false");
    url.searchParams.set("asLegacyTransaction", "true");

    logger.info(`Jupiter: requesting quote ${inputMint.slice(0, 8)}… → ${outputMint.slice(0, 8)}… amount=${inputAmount}`);

    const resp = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      throw new Error(`Jupiter quote API returned ${resp.status}: ${await resp.text()}`);
    }

    const quote = await resp.json();
    logger.info(
      `Jupiter: best route – inAmt=${quote.inAmount} outAmt=${quote.outAmount} ` +
      `priceImpact=${quote.priceImpactPct}% routes=${quote.routePlan?.length ?? 0}`
    );
    return quote;
  }

  /**
   * Build a swap transaction using Jupiter's swap API.
   *
   * @param {QuoteResponse} quote          – Response from getQuote()
   * @param {string}        userPublicKey  – Signer's public key (base58)
   * @returns {Promise<Transaction>}
   */
  async buildSwapTransaction(quote, userPublicKey) {
    const body = {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      asLegacyTransaction: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    };

    const resp = await fetch(JUPITER_SWAP_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`Jupiter swap API returned ${resp.status}: ${await resp.text()}`);
    }

    const { swapTransaction } = await resp.json();

    // Deserialize the base64-encoded transaction
    const txBuffer = Buffer.from(swapTransaction, "base64");
    const tx = Transaction.from(txBuffer);
    return tx;
  }

  /**
   * Full swap flow: quote → build tx → sign & broadcast.
   * Returns the transaction signature.
   *
   * @param {WalletManager} walletManager
   * @param {string}        inputMint
   * @param {string}        outputMint
   * @param {number}        inputAmount   – lamports
   * @param {number}        [slippageBps]
   * @returns {Promise<{ signature: string, outAmount: string, priceImpact: string }>}
   */
  async executeSwap(walletManager, inputMint, outputMint, inputAmount, slippageBps = 50) {
    logger.info(
      `[${walletManager.agentId}] Starting Jupiter swap ` +
      `${(inputAmount / 1e9).toFixed(6)} SOL → output token`
    );

    // 1. Get quote
    const quote = await this.getQuote(inputMint, outputMint, inputAmount, slippageBps);

    // 2. Build transaction
    const tx = await this.buildSwapTransaction(quote, walletManager.publicKey);

    // 3. Set blockhash
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = walletManager.publicKeyObj;

    // 4. Sign & broadcast
    const signature = await walletManager.signAndSend(tx);

    logger.info(
      `[${walletManager.agentId}] Jupiter swap confirmed – sig: ${signature} ` +
      `outAmount: ${quote.outAmount} priceImpact: ${quote.priceImpactPct}%`
    );

    return {
      signature,
      outAmount: quote.outAmount,
      priceImpact: quote.priceImpactPct,
    };
  }

  /**
   * Simulate a swap on devnet (mock, for demonstration).
   * Since devnet has no real liquidity, we simulate by:
   *   1. Fetching a real mainnet quote to show routing capability
   *   2. Logging the simulated trade on-chain via Memo Program
   *   3. Recording the simulated output amount
   *
   * This proves the integration works without requiring funded mainnet accounts.
   *
   * @param {WalletManager} walletManager
   * @param {string}        inputMint
   * @param {string}        outputMint
   * @param {number}        inputAmountLamports
   */
  async simulateSwap(walletManager, inputMint, outputMint, inputAmountLamports) {
    logger.info(`[${walletManager.agentId}] Simulating Jupiter swap (devnet mock)…`);

    let quoteData = null;

    try {
      quoteData = await this.getQuote(inputMint, outputMint, inputAmountLamports);
    } catch (err) {
      logger.warn(`Jupiter API not reachable: ${err.message}. Using simulated quote.`);
      quoteData = {
        inAmount: String(inputAmountLamports),
        outAmount: String(Math.round(inputAmountLamports * 0.000_01 * 145)),  // rough SOL/USDC rate
        priceImpactPct: "0.01",
        routePlan: [{ swapInfo: { label: "simulated" } }],
      };
    }

    // Log the simulated swap on-chain via Memo Program
    const memo = JSON.stringify({
      event: "SWAP_SIM",
      agent: walletManager.agentId,
      inputMint: inputMint.slice(0, 8),
      outputMint: outputMint.slice(0, 8),
      inAmt: quoteData.inAmount,
      outAmt: quoteData.outAmount,
      priceImpact: quoteData.priceImpactPct,
      timestamp: Date.now(),
    });

    // Import lazily to avoid circular dep
    const { DeFiProtocol } = await import("./DeFiProtocol.js");
    const proto = new DeFiProtocol();

    let sig = null;
    try {
      sig = await proto.logMemo(walletManager, memo);
    } catch (err) {
      logger.warn(`Memo log failed (insufficient funds?): ${err.message}`);
    }

    logger.info(
      `[${walletManager.agentId}] Swap sim: in=${quoteData.inAmount} → ` +
      `out=${quoteData.outAmount} | priceImpact=${quoteData.priceImpactPct}% ` +
      `| sig: ${sig?.slice(0, 12) ?? "none"}…`
    );

    return {
      signature: sig,
      inAmount: quoteData.inAmount,
      outAmount: quoteData.outAmount,
      priceImpact: quoteData.priceImpactPct,
      simulated: true,
    };
  }
}
