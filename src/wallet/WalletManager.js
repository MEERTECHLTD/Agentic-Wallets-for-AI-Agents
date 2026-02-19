/**
 * WalletManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Core wallet layer for agentic AI agents on Solana.
 *
 * Responsibilities
 * ────────────────
 * • Programmatic keypair generation
 * • Encrypted persistence to disk (AES-256-GCM via crypto.js)
 * • SOL balance queries and airdrop requests (devnet)
 * • SOL transfer (agent → arbitrary destination)
 * • SPL token balance queries
 * • Transaction signing (delegated to Solana web3.js)
 *
 * Security design
 * ───────────────
 * Private keys NEVER leave this module as raw bytes; all signing happens
 * inside signTransaction() so the agent logic only ever sees public keys
 * and transaction signatures.
 */

import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import bs58 from "bs58";
import { nanoid } from "nanoid";

import { getConnection, WALLET_STORAGE_DIR, AUTO_AIRDROP, AIRDROP_AMOUNT_SOL } from "../config.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";

const PASSPHRASE_ENV = "WALLET_PASSPHRASE";

function getPassphrase() {
  const pp = process.env[PASSPHRASE_ENV];
  if (!pp) {
    logger.warn(
      `[WalletManager] ${PASSPHRASE_ENV} env var not set – using insecure default. ` +
      `Set WALLET_PASSPHRASE in .env before deploying with real funds.`
    );
    return "devnet-agent-default-passphrase-change-me";
  }
  return pp;
}

export class WalletManager {
  /**
   * @param {string} agentId – Unique identifier for the owning agent.
   */
  constructor(agentId) {
    this.agentId = agentId;
    this._keypair = null; // loaded lazily
    this._storageDir = path.resolve(WALLET_STORAGE_DIR);
    mkdirSync(this._storageDir, { recursive: true });
  }

  // ─── Paths ──────────────────────────────────────────────────────────────────

  get _walletFile() {
    return path.join(this._storageDir, `${this.agentId}.wallet.enc`);
  }

  // ─── Creation & Loading ─────────────────────────────────────────────────────

  /**
   * Create a brand-new wallet, persist it, optionally airdrop on devnet.
   * @returns {Promise<{ publicKey: string, agentId: string }>}
   */
  async createWallet() {
    if (existsSync(this._walletFile)) {
      logger.warn(`[${this.agentId}] Wallet file already exists – loading instead of creating.`);
      return this.loadWallet();
    }

    const keypair = Keypair.generate();
    this._keypair = keypair;

    // Persist encrypted secret key
    const secretB58 = bs58.encode(keypair.secretKey);
    const encrypted = encrypt(secretB58, getPassphrase());
    writeFileSync(this._walletFile, JSON.stringify({
      agentId: this.agentId,
      publicKey: keypair.publicKey.toBase58(),
      encryptedSecret: encrypted,
      createdAt: new Date().toISOString(),
    }), "utf8");

    logger.info(`[${this.agentId}] Wallet created – ${keypair.publicKey.toBase58()}`);

    if (AUTO_AIRDROP) {
      await this._requestAirdrop(AIRDROP_AMOUNT_SOL);
    }

    return { publicKey: keypair.publicKey.toBase58(), agentId: this.agentId };
  }

  /**
   * Load an existing wallet from disk.
   * @returns {{ publicKey: string, agentId: string }}
   */
  loadWallet() {
    if (!existsSync(this._walletFile)) {
      throw new Error(`[${this.agentId}] No wallet found at ${this._walletFile}. Call createWallet() first.`);
    }

    const raw = JSON.parse(readFileSync(this._walletFile, "utf8"));
    const secretB58 = decrypt(raw.encryptedSecret, getPassphrase());
    const secretKey = bs58.decode(secretB58);
    this._keypair = Keypair.fromSecretKey(secretKey);

    logger.info(`[${this.agentId}] Wallet loaded – ${this._keypair.publicKey.toBase58()}`);
    return { publicKey: this._keypair.publicKey.toBase58(), agentId: this.agentId };
  }

  /**
   * Create if not found, otherwise load.
   */
  async getOrCreate() {
    if (existsSync(this._walletFile)) {
      return this.loadWallet();
    }
    return this.createWallet();
  }

  // ─── Keypair Access (internal) ──────────────────────────────────────────────

  _getKeypair() {
    if (!this._keypair) throw new Error(`[${this.agentId}] Wallet not loaded. Call loadWallet() or createWallet().`);
    return this._keypair;
  }

  /** Public key as Base58 string (safe to share). */
  get publicKey() {
    return this._getKeypair().publicKey.toBase58();
  }

  /** Solana PublicKey object. */
  get publicKeyObj() {
    return this._getKeypair().publicKey;
  }

  // ─── Balances ───────────────────────────────────────────────────────────────

  /**
   * Returns SOL balance in human-readable units.
   */
  async getSOLBalance() {
    const conn = getConnection();
    const lamports = await conn.getBalance(this.publicKeyObj);
    return lamports / LAMPORTS_PER_SOL;
  }

  /**
   * Returns the token balance for an SPL mint.
   * @param {string} mintAddress
   */
  async getTokenBalance(mintAddress) {
    const conn = getConnection();
    try {
      const mint = new PublicKey(mintAddress);
      const ata = await getAssociatedTokenAddress(mint, this.publicKeyObj);
      const account = await getAccount(conn, ata);
      return Number(account.amount);
    } catch {
      return 0; // account doesn't exist → balance is 0
    }
  }

  // ─── Transfers ──────────────────────────────────────────────────────────────

  /**
   * Send SOL from this wallet to a destination address.
   * @param {string} destinationAddress
   * @param {number} amountSOL
   * @returns {Promise<string>} Transaction signature
   */
  async sendSOL(destinationAddress, amountSOL) {
    const conn = getConnection();
    const keypair = this._getKeypair();
    const destination = new PublicKey(destinationAddress);
    const lamports = Math.round(amountSOL * LAMPORTS_PER_SOL);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: destination,
        lamports,
      })
    );

    const destShort = `${destinationAddress.slice(0, 8)}…${destinationAddress.slice(-6)}`;
    logger.info(`[${this.agentId}] Sending ${amountSOL} SOL → ${destShort}`);
    const sig = await sendAndConfirmTransaction(conn, tx, [keypair]);
    logger.info(`[${this.agentId}] SOL transfer confirmed – sig: ${sig}`);
    return sig;
  }

  // ─── Transaction Signing (generic) ──────────────────────────────────────────

  /**
   * Sign an arbitrary pre-built Transaction object.
   * The private key never leaves this method.
   * @param {Transaction} transaction
   * @returns {Promise<string>} Confirmed transaction signature
   */
  async signAndSend(transaction) {
    const conn = getConnection();
    const keypair = this._getKeypair();
    const sig = await sendAndConfirmTransaction(conn, transaction, [keypair]);
    logger.info(`[${this.agentId}] Tx confirmed – ${sig}`);
    return sig;
  }

  /**
   * Sign a transaction and return the signed Transaction object
   * without broadcasting (useful for multi-sig flows).
   * @param {Transaction} transaction
   * @returns {Transaction}
   */
  signOnly(transaction) {
    const conn = getConnection();
    const keypair = this._getKeypair();
    transaction.feePayer = keypair.publicKey;
    transaction.sign(keypair);
    return transaction;
  }

  // ─── Devnet Helpers ─────────────────────────────────────────────────────────

  async _requestAirdrop(solAmount) {
    const conn = getConnection();
    const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);
    logger.info(`[${this.agentId}] Requesting airdrop of ${solAmount} SOL…`);
    try {
      const sig = await conn.requestAirdrop(this.publicKeyObj, lamports);
      await conn.confirmTransaction(sig, "confirmed");
      logger.info(`[${this.agentId}] Airdrop confirmed – ${sig}`);
    } catch (err) {
      logger.warn(`[${this.agentId}] Airdrop failed (rate-limited?): ${err.message}`);
    }
  }

  /** Force-request an airdrop (public, for manual testing). */
  async airdrop(solAmount = AIRDROP_AMOUNT_SOL) {
    await this._requestAirdrop(solAmount);
  }

  // ─── Static Utilities ───────────────────────────────────────────────────────

  /**
   * List all persisted agent wallet IDs on disk.
   */
  static listAll(storageDir = WALLET_STORAGE_DIR) {
    const dir = path.resolve(storageDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".wallet.enc"))
      .map((f) => f.replace(".wallet.enc", ""));
  }

  /**
   * Generate a fresh unique agent ID.
   */
  static generateAgentId(prefix = "agent") {
    return `${prefix}-${nanoid(8)}`;
  }
}
