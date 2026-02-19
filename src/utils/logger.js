/**
 * logger.js
 * Structured logger backed by Winston.
 * Writes to console (coloured) and to a rotating log file.
 */

import { createLogger, format, transports } from "winston";
import { mkdirSync } from "fs";
import path from "path";
import { LOG_LEVEL, LOG_FILE } from "../config.js";

// Ensure log directory exists
const logDir = path.dirname(LOG_FILE);
mkdirSync(logDir, { recursive: true });

const { combine, timestamp, printf, colorize, errors } = format;

const logFmt = printf(({ level, message, timestamp, agentId, ...meta }) => {
  const agent = agentId ? ` [${agentId}]` : "";
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp}${agent} ${level}: ${message}${extra}`;
});

export const logger = createLogger({
  level: LOG_LEVEL,
  format: combine(errors({ stack: true }), timestamp(), logFmt),
  transports: [
    new transports.Console({
      format: combine(colorize(), timestamp(), logFmt),
    }),
    new transports.File({ filename: LOG_FILE }),
  ],
});

/** Returns a child logger pre-tagged with agentId */
export function agentLogger(agentId) {
  return logger.child({ agentId });
}
