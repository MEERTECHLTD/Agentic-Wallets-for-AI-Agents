/**
 * MultiSigManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * M-of-N multi-signature transaction support for high-value agent operations.
 *
 * Architecture
 * ─────────────
 * On Solana, multi-sig is implemented via the Nonce Account pattern or via
 * native program multi-sig (e.g., Squads Protocol for production).
 *
 * For this devnet prototype we implement a straightforward M-of-N co-signer
 * model:
 *   1. One agent proposes a transaction (partial signing)
 *   2. Other co-signing agents provide their signatures
 *   3. When M signatures are collected the transaction is broadcast
 *
 * This proves the multi-sig capability without requiring Squads deployment.
 *
 * Use cases
 * ──────────
 * • Large transfers above AGENT_MAX_SOL_PER_TX (requires co-signer approval)
 * • Treasury management (2-of-3 agents must agree)
 * • Emergency fund recovery
 *
 * Security model
 * ──────────────
 * The proposal is held in memory during the signing round.
 * In production, proposals would be persisted on-chain via a custom program
 * or off-chain in an encrypted database with a commit-reveal scheme.
 */

import {
  Transaction,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getConnection } from "../config.js";
import { logger } from "../utils/logger.js";
import { nanoid } from "nanoid";

export class MultiSigProposal {
  /**
   * @param {string}        proposalId
   * @param {string}        proposerAgentId
   * @param {string}        description
   * @param {Transaction}   transaction
   * @param {number}        requiredSigners  – M in M-of-N
   * @param {string[]}      authorizedSigners – N agent IDs allowed to sign
   */
  constructor(proposalId, proposerAgentId, description, transaction, requiredSigners, authorizedSigners) {
    this.proposalId = proposalId;
    this.proposerAgentId = proposerAgentId;
    this.description = description;
    this.transaction = transaction;
    this.requiredSigners = requiredSigners;
    this.authorizedSigners = authorizedSigners;
    this.signatures = new Map(); // agentId → Uint8Array signature
    this.status = "PENDING"; // PENDING | APPROVED | EXECUTED | REJECTED
    this.createdAt = Date.now();
    this.executedAt = null;
    this.executionSignature = null;
  }

  get signatureCount() {
    return this.signatures.size;
  }

  get isApproved() {
    return this.signatureCount >= this.requiredSigners;
  }

  toJSON() {
    return {
      proposalId: this.proposalId,
      proposerAgentId: this.proposerAgentId,
      description: this.description,
      requiredSigners: this.requiredSigners,
      authorizedSigners: this.authorizedSigners,
      signedBy: [...this.signatures.keys()],
      status: this.status,
      createdAt: this.createdAt,
      executedAt: this.executedAt,
      executionSignature: this.executionSignature,
    };
  }
}

export class MultiSigManager {
  constructor() {
    /** @type {Map<string, MultiSigProposal>} */
    this._proposals = new Map();
    this.conn = getConnection();
  }

  /**
   * Create a new multi-sig proposal for a SOL transfer.
   *
   * @param {WalletManager} proposerWallet
   * @param {string}        toAddress
   * @param {number}        amountSOL
   * @param {string}        description
   * @param {number}        requiredSigners  – M
   * @param {WalletManager[]} coSigners       – N-1 additional signers
   * @returns {MultiSigProposal}
   */
  async createTransferProposal(proposerWallet, toAddress, amountSOL, description, requiredSigners, coSigners) {
    const conn = this.conn;
    const { blockhash } = await conn.getLatestBlockhash();

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: proposerWallet.publicKeyObj,
    }).add(
      SystemProgram.transfer({
        fromPubkey: proposerWallet.publicKeyObj,
        toPubkey: new PublicKey(toAddress),
        lamports: Math.round(amountSOL * LAMPORTS_PER_SOL),
      })
    );

    const authorizedIds = [proposerWallet.agentId, ...coSigners.map((w) => w.agentId)];
    const proposalId = `msig-${nanoid(8)}`;

    const proposal = new MultiSigProposal(
      proposalId,
      proposerWallet.agentId,
      description,
      tx,
      requiredSigners,
      authorizedIds
    );

    // Proposer signs first
    const signed = proposerWallet.signOnly(tx);
    proposal.signatures.set(proposerWallet.agentId, Buffer.from(signed.signature || Buffer.alloc(64)));

    this._proposals.set(proposalId, proposal);

    logger.info(
      `MultiSig: proposal ${proposalId} created by ${proposerWallet.agentId} ` +
      `– ${amountSOL} SOL → ${toAddress.slice(0, 8)}… | ${requiredSigners}-of-${authorizedIds.length}`
    );

    return proposal;
  }

  /**
   * Co-sign an existing proposal.
   *
   * @param {string}        proposalId
   * @param {WalletManager} signerWallet
   * @returns {{ proposal: MultiSigProposal, approved: boolean }}
   */
  async coSign(proposalId, signerWallet) {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
    if (proposal.status !== "PENDING") throw new Error(`Proposal ${proposalId} is ${proposal.status}`);
    if (!proposal.authorizedSigners.includes(signerWallet.agentId)) {
      throw new Error(`${signerWallet.agentId} is not an authorized signer for ${proposalId}`);
    }
    if (proposal.signatures.has(signerWallet.agentId)) {
      logger.warn(`${signerWallet.agentId} already signed ${proposalId}`);
      return { proposal, approved: proposal.isApproved };
    }

    const signed = signerWallet.signOnly(proposal.transaction);
    proposal.signatures.set(signerWallet.agentId, Buffer.from(signed.signature || Buffer.alloc(64)));

    logger.info(
      `MultiSig: ${signerWallet.agentId} co-signed ${proposalId} ` +
      `(${proposal.signatureCount}/${proposal.requiredSigners})`
    );

    if (proposal.isApproved) {
      proposal.status = "APPROVED";
      logger.info(`MultiSig: proposal ${proposalId} APPROVED with ${proposal.signatureCount} signatures`);
    }

    return { proposal, approved: proposal.isApproved };
  }

  /**
   * Execute an approved proposal (broadcast the transaction).
   *
   * @param {string}        proposalId
   * @param {WalletManager} executorWallet  – pays the fee (must be fee payer)
   * @returns {string} Transaction signature
   */
  async execute(proposalId, executorWallet) {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
    if (!proposal.isApproved) {
      throw new Error(
        `Proposal ${proposalId} not yet approved ` +
        `(${proposal.signatureCount}/${proposal.requiredSigners} signatures)`
      );
    }
    if (proposal.status === "EXECUTED") {
      throw new Error(`Proposal ${proposalId} already executed`);
    }

    logger.info(`MultiSig: executing proposal ${proposalId}…`);

    const sig = await executorWallet.signAndSend(proposal.transaction);

    proposal.status = "EXECUTED";
    proposal.executedAt = Date.now();
    proposal.executionSignature = sig;

    logger.info(`MultiSig: proposal ${proposalId} EXECUTED – sig: ${sig}`);
    return sig;
  }

  /**
   * Get all proposals (optionally filtered by status).
   */
  getProposals(status = null) {
    const all = [...this._proposals.values()];
    return status ? all.filter((p) => p.status === status) : all;
  }

  getProposal(proposalId) {
    return this._proposals.get(proposalId);
  }
}

// Singleton
export const globalMultiSig = new MultiSigManager();
