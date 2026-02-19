/**
 * dashboard/server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time web dashboard for observing agentic wallets.
 *
 * Architecture
 * ─────────────
 * • Express HTTP server serves the frontend HTML/JS/CSS
 * • WebSocket server (ws) pushes live events to all connected browsers
 * • REST API endpoints for agent management
 *
 * Usage:
 *   node src/dashboard/server.js
 *   # Open http://localhost:3000 in browser
 *
 * WebSocket events pushed to clients:
 *   { type: "decision", ...payload }
 *   { type: "action", ...payload }
 *   { type: "error", ...payload }
 *   { type: "stats", agents: [...] }
 *   { type: "connected", agentCount: N }
 */

import "dotenv/config";
import http from "http";
import { WebSocketServer } from "ws";
import { AgentRunner } from "../agent/AgentRunner.js";
import { WalletManager } from "../wallet/WalletManager.js";
import { logger } from "../utils/logger.js";

const PORT = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || "3000");
const AGENT_IDS = (process.env.AGENT_IDS || "agent-01,agent-02,agent-03").split(",").map((s) => s.trim());
const TICK_MS = parseInt(process.env.AGENT_DECISION_INTERVAL_MS || "20000");

const runners = new Map();
const wsClients = new Set();

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getDashboardHTML());
    return;
  }

  if (req.method === "GET" && req.url === "/api/agents") {
    const agents = AGENT_IDS.map((id) => {
      const runner = runners.get(id);
      return runner ? runner.getStats() : { agentId: id, running: false };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agents));
    return;
  }

  if (req.method === "POST" && req.url === "/api/start") {
    startAllAgents().then(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/stop") {
    for (const [, r] of runners) r.stop();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // SSE endpoint – fallback for platforms that block WebSocket upgrades
  if (req.method === "GET" && req.url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.flushHeaders();

    // Send initial state
    const initPayload = JSON.stringify({
      type: "connected",
      agentCount: runners.size,
      agents: AGENT_IDS.map((id) => {
        const r = runners.get(id);
        return r ? r.getStats() : { agentId: id, running: false };
      }),
    });
    res.write(`data: ${initPayload}\n\n`);

    sseClients.add(res);
    logger.info(`Dashboard: new SSE client (total: ${sseClients.size})`);

    // Heartbeat to keep connection alive
    const hb = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); }
    }, 20000);

    req.on("close", () => {
      sseClients.delete(res);
      clearInterval(hb);
      logger.info(`Dashboard: SSE client disconnected (total: ${sseClients.size})`);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ── WebSocket Server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  wsClients.add(ws);
  logger.info(`Dashboard: new WebSocket client (total: ${wsClients.size})`);

  ws.send(JSON.stringify({
    type: "connected",
    agentCount: runners.size,
    agents: AGENT_IDS.map((id) => {
      const r = runners.get(id);
      return r ? r.getStats() : { agentId: id, running: false };
    }),
  }));

  ws.on("close", () => {
    wsClients.delete(ws);
    logger.info(`Dashboard: client disconnected (total: ${wsClients.size})`);
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    } catch { /* ignore */ }
  });
});

// ── SSE clients (fallback for platforms that block WebSocket) ─────────────────
const sseClients = new Set();

function broadcast(payload) {
  const str = JSON.stringify(payload);
  // WebSocket broadcast
  for (const ws of wsClients) {
    if (ws.readyState === 1 /* OPEN */) ws.send(str);
  }
  // SSE broadcast
  for (const res of sseClients) {
    try { res.write(`data: ${str}\n\n`); } catch { sseClients.delete(res); }
  }
}

// ── Agent Management ──────────────────────────────────────────────────────────

async function startAllAgents() {
  logger.info(`Dashboard: initialising ${AGENT_IDS.length} agents…`);

  const allRunners = await Promise.all(
    AGENT_IDS.map((id) => new AgentRunner(id).init())
  );

  const allWallets = allRunners.map((r) => r.wallet);
  for (const runner of allRunners) {
    runner.setPeers(allWallets.filter((w) => w.agentId !== runner.agentId));
    runners.set(runner.agentId, runner);
  }

  for (const runner of allRunners) {
    runner.on("decision", (d) => {
      broadcast({ type: "decision", ...d });
    });
    runner.on("action", (a) => {
      broadcast({ type: "action", ...a });
      logger.info(`[${a.agentId}] ${a.action} ${a.amount || ""}`);
    });
    runner.on("error", (e) => {
      broadcast({ type: "error", ...e });
    });
    runner.start(TICK_MS);
  }

  broadcast({ type: "started", agentCount: allRunners.length });

  // Broadcast live stats every 10 seconds
  setInterval(() => {
    const stats = [...runners.values()].map((r) => r.getStats());
    broadcast({ type: "stats", agents: stats });
  }, 10_000);
}

// ── Frontend HTML ─────────────────────────────────────────────────────────────

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agentic Wallet Dashboard · Solana Devnet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  /* ── Reset & base ─────────────────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  /* ── Claude colour palette ────────────────────────────────── */
  :root {
    --bg-base:       #1C1917;   /* warm near-black  */
    --bg-surface:    #292524;   /* card backgrounds  */
    --bg-elevated:   #342F2E;   /* hover / elevated  */
    --bg-overlay:    #3D3835;   /* input / overlay   */

    --claude-orange:  #F28B6B;  /* Claude brand orange – brighter */
    --claude-orange2: #DA7756;  /* darker orange      */
    --claude-cream:   #FAF4E8;  /* warm cream text – max bright  */
    --claude-tan:     #E8D5B8;  /* muted cream – much brighter   */
    --claude-sand:    #C8AE96;  /* secondary text – brighter     */

    --accent-green:  #4ADE80;
    --accent-blue:   #60A5FA;
    --accent-amber:  #FBBF24;
    --accent-red:    #F87171;
    --accent-purple: #A78BFA;

    --border:        rgba(218,119,86,0.15);
    --border-bright: rgba(218,119,86,0.35);
    --glow:          rgba(218,119,86,0.12);

    --radius-sm: 8px;
    --radius-md: 14px;
    --radius-lg: 20px;

    --font-sans: 'Inter', system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', 'Courier New', monospace;
  }

  html { height: 100%; }

  body {
    min-height: 100vh;
    background: var(--bg-base);
    color: var(--claude-cream);
    font-family: var(--font-sans);
    font-size: 15px;
    font-weight: 400;
    line-height: 1.65;
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Noise texture overlay ───────────────────────────────── */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 0;
    opacity: 0.4;
  }

  /* ── Layout ──────────────────────────────────────────────── */
  .app {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 100vh;
  }

  /* ── Top nav ─────────────────────────────────────────────── */
  .navbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 28px;
    border-bottom: 1px solid var(--border);
    background: rgba(28,25,23,0.85);
    backdrop-filter: blur(20px);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .navbar-brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .brand-icon {
    width: 38px; height: 38px;
    background: linear-gradient(135deg, var(--claude-orange), var(--claude-orange2));
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px;
    box-shadow: 0 0 20px rgba(218,119,86,0.4);
    flex-shrink: 0;
  }

  .brand-text h1 {
    font-size: 15px;
    font-weight: 700;
    color: var(--claude-cream);
    letter-spacing: -0.3px;
  }

  .brand-text p {
    font-size: 12px;
    color: var(--claude-tan);
    font-family: var(--font-mono);
    letter-spacing: 0.3px;
  }

  .navbar-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  /* ── Live indicator ──────────────────────────────────────── */
  .live-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 14px;
    border-radius: 100px;
    background: rgba(74,222,128,0.12);
    border: 1px solid rgba(74,222,128,0.4);
    font-size: 12px;
    font-weight: 700;
    color: var(--accent-green);
    letter-spacing: 0.5px;
  }

  .live-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--accent-green);
    animation: pulse-green 2s ease infinite;
  }

  .live-badge.offline {
    background: rgba(248,113,113,0.1);
    border-color: rgba(248,113,113,0.25);
    color: var(--accent-red);
  }

  .live-badge.offline .live-dot {
    background: var(--accent-red);
    animation: none;
  }

  @keyframes pulse-green {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(74,222,128,0.5); }
    50%       { opacity: 0.7; box-shadow: 0 0 0 5px rgba(74,222,128,0); }
  }

  /* ── Buttons ─────────────────────────────────────────────── */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.18s ease;
    letter-spacing: -0.1px;
  }

  .btn-primary {
    background: var(--claude-orange);
    color: #fff;
    border-color: var(--claude-orange);
  }
  .btn-primary:hover {
    background: var(--claude-orange2);
    border-color: var(--claude-orange2);
    box-shadow: 0 0 18px rgba(218,119,86,0.45);
    transform: translateY(-1px);
  }

  .btn-ghost {
    background: transparent;
    color: var(--claude-tan);
    border-color: var(--border-bright);
  }
  .btn-ghost:hover {
    background: var(--bg-elevated);
    color: var(--claude-cream);
    border-color: rgba(218,119,86,0.5);
  }

  .btn-danger {
    background: rgba(248,113,113,0.12);
    color: var(--accent-red);
    border-color: rgba(248,113,113,0.3);
  }
  .btn-danger:hover {
    background: rgba(248,113,113,0.22);
    box-shadow: 0 0 14px rgba(248,113,113,0.25);
    transform: translateY(-1px);
  }

  .btn-icon { font-size: 15px; }

  /* ── Main content ────────────────────────────────────────── */
  .main {
    display: grid;
    grid-template-columns: 1fr 380px;
    gap: 0;
    height: calc(100vh - 71px);
  }

  .content-left {
    padding: 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .content-right {
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Section headers ─────────────────────────────────────── */
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }

  .section-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--claude-tan);
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .section-count {
    font-size: 12px;
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--claude-orange);
    background: rgba(242,139,107,0.12);
    border: 1px solid rgba(242,139,107,0.35);
    padding: 3px 10px;
    border-radius: 100px;
  }

  /* ── Stats bar ───────────────────────────────────────────── */
  .stats-bar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
  }

  .stat-tile {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
    transition: border-color 0.2s;
  }

  .stat-tile:hover { border-color: var(--border-bright); }

  .stat-tile-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--claude-tan);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 8px;
  }

  .stat-tile-value {
    font-size: 26px;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--claude-cream);
    letter-spacing: -1px;
  }

  .stat-tile-value.orange { color: var(--claude-orange); }
  .stat-tile-value.green  { color: var(--accent-green); }
  .stat-tile-value.blue   { color: var(--accent-blue); }
  .stat-tile-value.amber  { color: var(--accent-amber); }

  .stat-tile-sub {
    font-size: 12px;
    font-weight: 500;
    color: var(--claude-tan);
    margin-top: 4px;
  }

  /* ── Agent cards grid ────────────────────────────────────── */
  .agents-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
    gap: 14px;
  }

  .agent-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 20px;
    transition: all 0.22s ease;
    position: relative;
    overflow: hidden;
  }

  .agent-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--card-accent, var(--claude-orange)), transparent);
    opacity: 0;
    transition: opacity 0.3s;
  }

  .agent-card:hover { border-color: var(--border-bright); transform: translateY(-2px); box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
  .agent-card:hover::before { opacity: 1; }
  .agent-card.active { border-color: rgba(218,119,86,0.4); }
  .agent-card.active::before { opacity: 1; }

  /* Card header */
  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 14px;
  }

  .card-id-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 4px;
  }

  .card-avatar {
    width: 32px; height: 32px;
    border-radius: 8px;
    background: linear-gradient(135deg, var(--claude-orange), var(--claude-orange2));
    display: flex; align-items: center; justify-content: center;
    font-size: 14px;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }

  .card-name {
    font-size: 15px;
    font-weight: 700;
    color: var(--claude-cream);
    letter-spacing: -0.2px;
  }

  .card-pubkey {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--claude-tan);
    margin-top: 2px;
    letter-spacing: 0.3px;
  }

  /* State badge */
  .state-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 12px;
    border-radius: 100px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  .state-dot {
    width: 5px; height: 5px;
    border-radius: 50%;
  }

  .state-IDLE  { background: rgba(200,174,150,0.18); color: var(--claude-tan); border: 1px solid rgba(200,174,150,0.4); }
  .state-IDLE .state-dot  { background: var(--claude-tan); }
  .state-TRADE { background: rgba(74,222,128,0.1); color: var(--accent-green); border: 1px solid rgba(74,222,128,0.25); }
  .state-TRADE .state-dot { background: var(--accent-green); animation: pulse-green 1.5s infinite; }
  .state-YIELD { background: rgba(96,165,250,0.1); color: var(--accent-blue); border: 1px solid rgba(96,165,250,0.25); }
  .state-YIELD .state-dot { background: var(--accent-blue); }
  .state-REBAL { background: rgba(251,191,36,0.1); color: var(--accent-amber); border: 1px solid rgba(251,191,36,0.25); }
  .state-REBAL .state-dot { background: var(--accent-amber); }

  /* Balance display */
  .card-balance-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 16px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }

  .card-balance {
    font-size: 26px;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--claude-orange);
    letter-spacing: -1.5px;
    line-height: 1;
  }

  .card-balance-unit {
    font-size: 14px;
    color: var(--claude-tan);
    font-weight: 600;
  }

  /* Stat rows */
  .card-stats { display: flex; flex-direction: column; gap: 9px; }

  .card-stat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
  }

  .card-stat-label { color: var(--claude-tan); font-weight: 500; }

  .card-stat-value {
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--claude-cream);
  }

  /* Progress bar for volume */
  .card-progress-wrap {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .card-progress-label {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    font-weight: 500;
    color: var(--claude-tan);
    margin-bottom: 6px;
  }

  .card-progress-bar {
    height: 3px;
    background: var(--bg-overlay);
    border-radius: 3px;
    overflow: hidden;
  }

  .card-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--claude-orange), var(--claude-orange2));
    border-radius: 3px;
    transition: width 0.8s cubic-bezier(0.16, 1, 0.3, 1);
    min-width: 4px;
  }

  /* Running pill */
  .card-running-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.3px;
    padding: 3px 8px;
    border-radius: 100px;
  }

  .pill-on  { background: rgba(74,222,128,0.15); color: var(--accent-green); font-size: 11px; }
  .pill-off { background: rgba(200,174,150,0.15); color: var(--claude-tan); font-size: 11px; }

  /* ── Right panel – event feed ────────────────────────────── */
  .feed-header {
    padding: 18px 20px 14px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }

  .feed-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .feed-title-text {
    font-size: 13px;
    font-weight: 700;
    color: var(--claude-tan);
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .feed-count {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--claude-orange);
    background: rgba(218,119,86,0.12);
    padding: 2px 7px;
    border-radius: 100px;
    border: 1px solid rgba(218,119,86,0.2);
  }

  .feed-clear-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--claude-sand);
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-family: var(--font-sans);
    transition: all 0.15s;
  }
  .feed-clear-btn:hover { border-color: var(--border-bright); color: var(--claude-cream); }

  .feed-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 0;
  }

  .feed-scroll::-webkit-scrollbar { width: 4px; }
  .feed-scroll::-webkit-scrollbar-track { background: transparent; }
  .feed-scroll::-webkit-scrollbar-thumb { background: var(--bg-overlay); border-radius: 4px; }

  .feed-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 200px;
    color: var(--claude-sand);
    font-size: 13px;
    gap: 8px;
    opacity: 0.6;
  }

  .feed-empty-icon { font-size: 28px; opacity: 0.5; }

  /* Feed events */
  .feed-event {
    padding: 11px 18px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    animation: slideIn 0.25s ease;
    cursor: default;
    transition: background 0.15s;
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }

  .feed-event:hover { background: rgba(255,255,255,0.02); }

  @keyframes slideIn {
    from { opacity: 0; transform: translateX(12px); }
    to   { opacity: 1; transform: translateX(0); }
  }

  .feed-event-icon {
    width: 28px; height: 28px;
    border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .icon-TRADE { background: rgba(74,222,128,0.12); }
  .icon-YIELD { background: rgba(96,165,250,0.12); }
  .icon-REBAL { background: rgba(251,191,36,0.12); }
  .icon-IDLE  { background: rgba(158,130,114,0.1); }
  .icon-error { background: rgba(248,113,113,0.12); }
  .icon-decision { background: rgba(167,139,250,0.12); }

  .feed-event-body { flex: 1; min-width: 0; }

  .feed-event-main {
    font-size: 13px;
    color: var(--claude-cream);
    line-height: 1.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ev-agent { color: var(--claude-orange); font-weight: 700; }
  .ev-action-TRADE { color: var(--accent-green); font-weight: 700; }
  .ev-action-YIELD { color: var(--accent-blue); font-weight: 700; }
  .ev-action-REBAL { color: var(--accent-amber); font-weight: 700; }
  .ev-action-IDLE  { color: var(--claude-tan); font-weight: 600; }
  .ev-error        { color: var(--accent-red); font-weight: 700; }
  .ev-decision     { color: var(--accent-purple); font-weight: 700; }

  .feed-event-meta {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 4px;
    flex-wrap: wrap;
  }

  .feed-event-time {
    font-size: 11px;
    color: var(--claude-tan);
    font-family: var(--font-mono);
    font-weight: 500;
  }

  .feed-event-sig {
    font-size: 11px;
    color: var(--claude-tan);
    font-family: var(--font-mono);
    background: var(--bg-elevated);
    padding: 1px 7px;
    border-radius: 4px;
  }

  /* ── Controls strip ──────────────────────────────────────── */
  .controls-strip {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    background: rgba(28,25,23,0.5);
    backdrop-filter: blur(10px);
    position: sticky;
    top: 71px;
    z-index: 50;
  }

  .controls-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--claude-tan);
    margin-right: 4px;
    letter-spacing: 0.3px;
  }

  .controls-spacer { flex: 1; }

  .network-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--claude-cream);
    background: var(--bg-surface);
    border: 1px solid var(--border-bright);
    padding: 5px 14px;
    border-radius: 100px;
  }

  .network-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent-green);
    box-shadow: 0 0 6px var(--accent-green);
  }

  /* ── Scrollbar global ────────────────────────────────────── */
  .content-left::-webkit-scrollbar { width: 5px; }
  .content-left::-webkit-scrollbar-track { background: transparent; }
  .content-left::-webkit-scrollbar-thumb { background: var(--bg-overlay); border-radius: 4px; }

  /* ── Responsive ──────────────────────────────────────────── */
  @media (max-width: 900px) {
    .main { grid-template-columns: 1fr; }
    .content-right { border-left: none; border-top: 1px solid var(--border); height: 360px; }
    .stats-bar { grid-template-columns: repeat(2, 1fr); }
  }

  @media (max-width: 560px) {
    .stats-bar { grid-template-columns: 1fr 1fr; }
    .navbar { padding: 12px 16px; }
    .controls-strip { padding: 10px 16px; gap: 8px; }
    .content-left { padding: 16px; }
  }

  /* ── Tooltip ─────────────────────────────────────────────── */
  [data-tip] { position: relative; cursor: help; }
  [data-tip]:hover::after {
    content: attr(data-tip);
    position: absolute;
    bottom: 120%;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-elevated);
    border: 1px solid var(--border-bright);
    color: var(--claude-cream);
    font-size: 11px;
    padding: 5px 10px;
    border-radius: 6px;
    white-space: nowrap;
    z-index: 999;
    pointer-events: none;
  }
</style>
</head>
<body>
<div class="app">

  <!-- ── Navbar ─────────────────────────────────────────────── -->
  <nav class="navbar">
    <div class="navbar-brand">
      <div class="brand-icon">⬡</div>
      <div class="brand-text">
        <h1>Agentic Wallet Dashboard</h1>
        <p>Superteam Nigeria · DeFi Developer Challenge</p>
      </div>
    </div>
    <div class="navbar-right">
      <div class="network-badge">
        <span class="network-dot"></span>
        solana · devnet
      </div>
      <div class="live-badge offline" id="liveBadge">
        <span class="live-dot" id="liveDot"></span>
        <span id="liveText">Connecting</span>
      </div>
    </div>
  </nav>

  <!-- ── Controls strip ─────────────────────────────────────── -->
  <div class="controls-strip">
    <span class="controls-label">Agents</span>
    <button class="btn btn-primary" onclick="startAgents()">
      <span class="btn-icon">▶</span> Start All
    </button>
    <button class="btn btn-danger" onclick="stopAgents()">
      <span class="btn-icon">⏹</span> Stop All
    </button>
    <div class="controls-spacer"></div>
  </div>

  <!-- ── Main ───────────────────────────────────────────────── -->
  <div class="main">

    <!-- Left: stats + agent cards -->
    <div class="content-left">

      <!-- Global stats bar -->
      <div>
        <div class="section-header">
          <span class="section-title">Network Overview</span>
        </div>
        <div class="stats-bar">
          <div class="stat-tile">
            <div class="stat-tile-label">Total Agents</div>
            <div class="stat-tile-value orange" id="gs-agents">0</div>
            <div class="stat-tile-sub">registered</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile-label">Total Cycles</div>
            <div class="stat-tile-value green" id="gs-cycles">0</div>
            <div class="stat-tile-sub">decisions made</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile-label">Total Trades</div>
            <div class="stat-tile-value blue" id="gs-trades">0</div>
            <div class="stat-tile-sub">on-chain txns</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile-label">Volume</div>
            <div class="stat-tile-value amber" id="gs-volume">0.0000</div>
            <div class="stat-tile-sub">SOL traded</div>
          </div>
        </div>
      </div>

      <!-- Agent cards -->
      <div>
        <div class="section-header">
          <span class="section-title">Agent Wallets</span>
          <span class="section-count" id="agentCountBadge">0 active</span>
        </div>
        <div class="agents-grid" id="agentGrid">
          <div style="color:var(--claude-sand);font-size:13px;opacity:0.6;padding:20px 0;">
            Waiting for agents to connect…
          </div>
        </div>
      </div>
    </div>

    <!-- Right: live event feed -->
    <div class="content-right">
      <div class="feed-header">
        <div class="feed-title-row">
          <span class="feed-title-text">📡 Live Feed</span>
          <span class="feed-count" id="feedCount">0 events</span>
        </div>
        <button class="feed-clear-btn" onclick="clearFeed()">Clear</button>
      </div>
      <div class="feed-scroll" id="feed">
        <div class="feed-empty" id="feedEmpty">
          <span class="feed-empty-icon">📭</span>
          <span>No events yet</span>
          <span style="font-size:11px;opacity:0.7">Start agents to see live activity</span>
        </div>
      </div>
    </div>

  </div>
</div>

<script>
/* ── State ────────────────────────────────────────────────────── */
const agents = {};
let ws, feedEventCount = 0;
const MAX_FEED = 300;

/* ── DOM refs ─────────────────────────────────────────────────── */
const grid          = document.getElementById("agentGrid");
const feed          = document.getElementById("feed");
const feedEmpty     = document.getElementById("feedEmpty");
const feedCount     = document.getElementById("feedCount");
const liveBadge     = document.getElementById("liveBadge");
const liveDot       = document.getElementById("liveDot");
const liveText      = document.getElementById("liveText");
const gsAgents      = document.getElementById("gs-agents");
const gsCycles      = document.getElementById("gs-cycles");
const gsTrades      = document.getElementById("gs-trades");
const gsVolume      = document.getElementById("gs-volume");
const agentCountBadge = document.getElementById("agentCountBadge");

/* ── Connection: WebSocket with SSE fallback ──────────────────── */
let wsFailCount = 0;

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(\`\${proto}//\${location.host}\`);

  const failTimer = setTimeout(() => {
    // WS didn't open within 4s – switch to SSE
    ws.close();
    connectSSE();
  }, 4000);

  ws.onopen = () => {
    clearTimeout(failTimer);
    wsFailCount = 0;
    setConnected(true);
    ping();
  };
  ws.onclose = () => {
    clearTimeout(failTimer);
    setConnected(false);
    wsFailCount++;
    if (wsFailCount >= 2) {
      // WS keeps failing – switch permanently to SSE
      connectSSE();
    } else {
      setTimeout(connect, 3000);
    }
  };
  ws.onerror = () => clearTimeout(failTimer);
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
}

function connectSSE() {
  const es = new EventSource("/api/events");
  es.onopen = () => setConnected(true);
  es.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  es.onerror = () => {
    setConnected(false);
    es.close();
    setTimeout(connectSSE, 5000);
  };
}

function ping() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ping" }));
    setTimeout(ping, 30000);
  }
}

function setConnected(ok) {
  liveBadge.className = "live-badge" + (ok ? "" : " offline");
  liveText.textContent = ok ? "Live" : "Reconnecting";
}

/* ── Message handler ──────────────────────────────────────────── */
function handleMessage(msg) {
  switch (msg.type) {
    case "connected":
    case "started":
      if (msg.agents) msg.agents.forEach(updateAgent);
      break;
    case "stats":
      msg.agents.forEach(updateAgent);
      updateGlobalStats();
      break;
    case "decision":
      updateAgentFromDecision(msg);
      addFeedEvent("decision", msg);
      updateGlobalStats();
      break;
    case "action":
      addFeedEvent("action", msg);
      break;
    case "error":
      addFeedEvent("error", msg);
      break;
  }
}

/* ── Agent card management ────────────────────────────────────── */
function updateAgent(a) {
  if (!a.agentId) return;
  agents[a.agentId] = { ...agents[a.agentId], ...a };
  renderCard(a.agentId);
  updateGlobalStats();
}

function updateAgentFromDecision(d) {
  if (!d.agentId) return;
  agents[d.agentId] = agents[d.agentId] || {};
  agents[d.agentId].state   = d.nextState;
  agents[d.agentId].cycles  = d.cycle;
  agents[d.agentId].balance = d.balance;
  renderCard(d.agentId);
}

function agentInitials(id) {
  const parts = id.replace("agent-","").replace("llm-","").replace("demo-","");
  return parts.slice(0,2).toUpperCase();
}

function renderCard(id) {
  const a     = agents[id] || {};
  const state = a.state || "IDLE";
  const bal   = a.balance != null ? a.balance.toFixed(4) : "—";
  const vol   = (a.volumeSOL || 0);
  const maxVol = Math.max(...Object.values(agents).map(x => x.volumeSOL || 0), 0.001);
  const pct   = Math.min((vol / maxVol) * 100, 100).toFixed(1);
  const running = a.running;

  const stateIcon = { IDLE:"💤", TRADE:"⚡", YIELD:"📈", REBAL:"⚖️" }[state] || "•";
  const pubkey    = a.publicKey ? a.publicKey.slice(0,8) + "…" + a.publicKey.slice(-6) : "…";

  const html = \`
  <div class="agent-card \${running ? "active" : ""}" id="card-\${id}">
    <div class="card-header">
      <div>
        <div class="card-id-row">
          <div class="card-avatar">\${agentInitials(id)}</div>
          <div>
            <div class="card-name">\${id}</div>
            <div class="card-pubkey" data-tip="\${a.publicKey || ''}">\${pubkey}</div>
          </div>
        </div>
      </div>
      <div>
        <div class="state-badge state-\${state}">
          <span class="state-dot"></span>
          \${stateIcon} \${state}
        </div>
      </div>
    </div>

    <div class="card-balance-row">
      <span class="card-balance">\${bal}</span>
      <span class="card-balance-unit">SOL</span>
    </div>

    <div class="card-stats">
      <div class="card-stat-row">
        <span class="card-stat-label">Decision Cycles</span>
        <span class="card-stat-value">\${a.cycles || 0}</span>
      </div>
      <div class="card-stat-row">
        <span class="card-stat-label">Trades Executed</span>
        <span class="card-stat-value">\${a.trades || 0}</span>
      </div>
      <div class="card-stat-row">
        <span class="card-stat-label">Status</span>
        <span class="card-running-pill \${running ? "pill-on" : "pill-off"}">
          \${running ? "● RUNNING" : "○ STOPPED"}
        </span>
      </div>
    </div>

    <div class="card-progress-wrap">
      <div class="card-progress-label">
        <span>Volume</span>
        <span>\${vol.toFixed(4)} SOL</span>
      </div>
      <div class="card-progress-bar">
        <div class="card-progress-fill" style="width:\${pct}%"></div>
      </div>
    </div>
  </div>\`;

  // Clear initial placeholder
  if (grid.querySelector("div[style]")) grid.innerHTML = "";

  const existing = document.getElementById("card-" + id);
  if (existing) existing.outerHTML = html;
  else grid.insertAdjacentHTML("beforeend", html);
}

/* ── Global stats ─────────────────────────────────────────────── */
function updateGlobalStats() {
  const vals = Object.values(agents);
  const running = vals.filter(a => a.running).length;
  gsAgents.textContent  = vals.length;
  gsCycles.textContent  = vals.reduce((s,a) => s + (a.cycles  || 0), 0);
  gsTrades.textContent  = vals.reduce((s,a) => s + (a.trades  || 0), 0);
  gsVolume.textContent  = vals.reduce((s,a) => s + (a.volumeSOL || 0), 0).toFixed(4);
  agentCountBadge.textContent = running + " active";
}

/* ── Feed events ──────────────────────────────────────────────── */
const ACTION_META = {
  TRADE: { icon: "⚡", cls: "icon-TRADE", label: "ev-action-TRADE" },
  YIELD: { icon: "📈", cls: "icon-YIELD", label: "ev-action-YIELD" },
  REBAL: { icon: "⚖️", cls: "icon-REBAL", label: "ev-action-REBAL" },
  IDLE:  { icon: "💤", cls: "icon-IDLE",  label: "ev-action-IDLE"  },
};

function addFeedEvent(type, msg) {
  // Hide empty state
  if (feedEmpty && feed.contains(feedEmpty)) feed.removeChild(feedEmpty);

  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  let icon = "•", iconCls = "icon-decision", mainHtml = "", metaHtml = "";

  if (type === "action") {
    const m  = ACTION_META[msg.action] || ACTION_META.IDLE;
    icon     = m.icon;
    iconCls  = m.cls;
    const ag = \`<span class="ev-agent">\${msg.agentId}</span>\`;
    const ac = \`<span class="\${m.label}">\${msg.action}</span>\`;

    if (msg.action === "TRADE") {
      mainHtml = \`\${ag} → \${ac} \${(msg.amount||0).toFixed(4)} SOL to <span class="ev-agent">\${msg.target||"?"}</span>\`;
    } else if (msg.action === "YIELD") {
      mainHtml = \`\${ag} → \${ac} event logged on-chain\`;
    } else if (msg.action === "REBAL") {
      mainHtml = \`\${ag} → \${ac} pool target \${(msg.targetBalance||0).toFixed(4)} SOL\`;
    } else {
      mainHtml = \`\${ag} → \${ac}\`;
    }
    if (msg.signature) {
      metaHtml += \`<span class="feed-event-sig">\${msg.signature.slice(0,14)}…</span>\`;
    }

  } else if (type === "decision") {
    icon    = "🧠";
    iconCls = "icon-decision";
    const ag = \`<span class="ev-agent">\${msg.agentId}</span>\`;
    const st = \`<span class="ev-decision">\${msg.nextState}</span>\`;
    mainHtml = \`\${ag} decided \${st}\${msg.reason ? \` — \${msg.reason}\` : ""}\`;

  } else if (type === "error") {
    icon    = "⚠";
    iconCls = "icon-error";
    mainHtml = \`<span class="ev-agent">\${msg.agentId}</span> <span class="ev-error">ERROR</span> \${msg.error || ""}\`;
  }

  metaHtml = \`<span class="feed-event-time">\${time}</span>\` + metaHtml;

  const el = document.createElement("div");
  el.className = "feed-event";
  el.innerHTML = \`
    <div class="feed-event-icon \${iconCls}">\${icon}</div>
    <div class="feed-event-body">
      <div class="feed-event-main">\${mainHtml}</div>
      <div class="feed-event-meta">\${metaHtml}</div>
    </div>\`;

  feed.insertBefore(el, feed.firstChild);

  feedEventCount++;
  feedCount.textContent = feedEventCount + " event" + (feedEventCount !== 1 ? "s" : "");

  while (feed.children.length > MAX_FEED) feed.removeChild(feed.lastChild);
}

/* ── Controls ─────────────────────────────────────────────────── */
async function startAgents() { await fetch("/api/start", { method: "POST" }); }
async function stopAgents()  { await fetch("/api/stop",  { method: "POST" }); }

function clearFeed() {
  feedEventCount = 0;
  feedCount.textContent = "0 events";
  feed.innerHTML = "";
  feed.appendChild(feedEmpty);
}

connect();
</script>
</body>
</html>`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  logger.info(`\n${"═".repeat(56)}`);
  logger.info(`  Agentic Wallet Dashboard`);
  logger.info(`  URL: http://localhost:${PORT}`);
  logger.info(`  Agents: ${AGENT_IDS.join(", ")}`);
  logger.info(`${"═".repeat(56)}\n`);
});

// Auto-start agents after 1s to let WS clients connect first
setTimeout(startAllAgents, 1_000);
