/**
 * DeFiProtocol.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Simulated devnet DeFi protocol interactions for AI agent wallets.
 *
 * On devnet there are no production liquidity pools, so we implement:
 *   1. SOL → mock-token swap  (creates a mock SPL token and mints to agent)
 *   2. Peer-to-peer SOL transfer between agents (real on-chain)
 *   3. Balance-weighted rebalancing across a pool of agents
 *   4. "Yield" simulation (time-based SOL accumulation logged on-chain via memo)
 *
 * Every action that touches the chain goes through WalletManager.signAndSend()
 * so private keys remain inside the wallet layer.
 */

import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getConnection } from "../config.js";
import { logger } from "../utils/logger.js";

// Memo program (for on-chain event logging)
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

export class DeFiProtocol {
  constructor() {
    this.conn = getConnection();
    /** Cache mint addresses created per-session (agentId → PublicKey) */
    this._agentMints = new Map();
  }

  // ─── Memo / On-chain Logging ─────────────────────────────────────────────

  /**
   * Write an arbitrary memo string to the chain.
   * Useful for event sourcing / audit trail without a custom program.
   */
  async logMemo(walletManager, memo) {
    const tx = new Transaction().add(
      new TransactionInstruction({
        keys: [
          {
            pubkey: walletManager.publicKeyObj,
            isSigner: true,
            isWritable: false,
          },
        ],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memo, "utf8"),
      })
    );
    const conn = getConnection();
    const { blockhash } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = walletManager.publicKeyObj;
    return walletManager.signAndSend(tx);
  }

  // ─── SOL Transfers (real on-chain) ──────────────────────────────────────

  /**
   * Simulate a trade: Agent A sends SOL to Agent B.
   * Models a spot swap in a two-agent market.
   */
  async executeTrade(fromWallet, toPublicKey, amountSOL) {
    logger.info(
      `DeFiProtocol: trade ${amountSOL} SOL ` +
      `${fromWallet.agentId} → ${toPublicKey.toString().slice(0, 8)}…`
    );
    const sig = await fromWallet.sendSOL(toPublicKey.toString(), amountSOL);
    await this.logMemo(
      fromWallet,
      JSON.stringify({ event: "TRADE", from: fromWallet.agentId, to: toPublicKey.toString(), amountSOL })
    ).catch(() => {}); // non-fatal
    return sig;
  }

  // ─── Mock SPL Token Mint ─────────────────────────────────────────────────

  /**
   * Create a unique mock token for an agent and mint an initial supply.
   * In a real integration this would be replaced by a protocol's token mint.
   *
   * @param {WalletManager} walletManager  – pays for the mint account
   * @param {number}        supplyUnits    – raw token units (no decimals)
   * @returns {{ mint: string, ata: string, signature: string }}
   */
  async mintAgentToken(walletManager, supplyUnits = 1_000_000) {
    const conn = this.conn;

    // The wallet keypair acts as mint authority (internal – never exposed)
    // We access it via the signAndSend pathway; for mint creation we need
    // the raw keypair reference. This is a deliberate exception for devnet.
    const keypair = walletManager._getKeypair(); // intentional internal access

    logger.info(`[${walletManager.agentId}] Creating SPL token mint…`);
    const mint = await createMint(
      conn,
      keypair,        // payer
      keypair.publicKey, // mint authority
      null,           // freeze authority – null = no freeze
      0               // decimals
    );

    const ata = await getOrCreateAssociatedTokenAccount(
      conn,
      keypair,
      mint,
      keypair.publicKey
    );

    const sig = await mintTo(
      conn,
      keypair,
      mint,
      ata.address,
      keypair.publicKey,
      supplyUnits
    );

    logger.info(
      `[${walletManager.agentId}] Minted ${supplyUnits} tokens ` +
      `– mint: ${mint.toBase58().slice(0, 8)}… sig: ${sig}`
    );

    this._agentMints.set(walletManager.agentId, mint);
    return { mint: mint.toBase58(), ata: ata.address.toBase58(), signature: sig };
  }

  // ─── Rebalancing ─────────────────────────────────────────────────────────

  /**
   * Rebalance SOL across a pool of agents so each holds roughly equal amounts.
   * Rich agents send to poor agents – models an autonomous liquidity manager.
   *
   * @param {WalletManager[]} wallets
   * @param {number} targetSOL  – desired balance per agent after rebalancing
   */
  async rebalancePool(wallets, targetSOL) {
    logger.info(`DeFiProtocol: rebalancing ${wallets.length} agents to ${targetSOL} SOL each`);

    const balances = await Promise.all(
      wallets.map(async (w) => ({ wallet: w, bal: await w.getSOLBalance() }))
    );

    const donors = balances.filter((b) => b.bal > targetSOL + 0.002);
    const receivers = balances.filter((b) => b.bal < targetSOL - 0.002);

    for (const receiver of receivers) {
      let needed = targetSOL - receiver.bal;
      for (const donor of donors) {
        if (needed <= 0) break;
        const available = donor.bal - targetSOL - 0.001; // keep some for fees
        if (available <= 0) continue;
        const send = Math.min(needed, available);
        try {
          await donor.wallet.sendSOL(receiver.wallet.publicKey, parseFloat(send.toFixed(6)));
          donor.bal -= send;
          receiver.bal += send;
          needed -= send;
          logger.info(
            `Rebalance: sent ${send.toFixed(4)} SOL ` +
            `${donor.wallet.agentId} → ${receiver.wallet.agentId}`
          );
        } catch (err) {
          logger.warn(`Rebalance transfer failed: ${err.message}`);
        }
      }
    }
  }

  // ─── Yield Simulation ────────────────────────────────────────────────────

  /**
   * Simulate "yield accrual" by writing a yield event memo on-chain.
   * In a real protocol an agent would claim from a yield program.
   */
  async simulateYield(walletManager, yieldSOL) {
    const memo = JSON.stringify({
      event: "YIELD",
      agent: walletManager.agentId,
      yieldSOL,
      timestamp: Date.now(),
    });
    logger.info(`[${walletManager.agentId}] Simulating yield: ${yieldSOL} SOL`);
    return this.logMemo(walletManager, memo).catch((err) => {
      logger.warn(`Yield memo failed: ${err.message}`);
      return null;
    });
  }
}
