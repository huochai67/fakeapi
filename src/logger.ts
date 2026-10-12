import fs from 'fs';
import path from 'path';
import { config } from './config.js';

export interface LogDetails {
  ip: string;
  method: string;
  path: string;
  model: string;
  turn: number;
  action: string;
  matchedRule?: string;
  stream: boolean;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  status: number;
  error?: string;
}

// Ensure log directory exists
const logDir = path.dirname(config.logFile);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

export function logRequest(details: LogDetails): void {
  const timestamp = new Date().toISOString();
  const cacheInfo = details.cachedTokens ? ` (cached: ${details.cachedTokens})` : '';
  const tokensInfo = details.promptTokens !== undefined
    ? ` [tokens: in=${details.promptTokens}${cacheInfo}, out=${details.completionTokens || 0}]`
    : '';
  const hitInfo = details.matchedRule ? ` | hit: "${details.matchedRule}"` : '';
  const errorInfo = details.error ? ` | error: ${details.error}` : '';

  const consoleLine = `[${timestamp}] [${details.ip}] #${details.turn} ${details.method} ${details.path} | model: ${details.model} | action: ${details.action}${hitInfo}${tokensInfo} | ${details.durationMs}ms [${details.status}]${errorInfo}`;
  console.log(consoleLine);

  const fileEntry = JSON.stringify({
    timestamp,
    ...details,
  }) + '\n';

  fs.appendFile(config.logFile, fileEntry, (err) => {
    if (err) {
      console.error(`[Logger] Failed to write log: ${err.message}`);
    }
  });
}
