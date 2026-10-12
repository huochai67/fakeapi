import dotenv from 'dotenv';
import path from 'path';

// Load .env
dotenv.config();

export interface GatewayConfig {
  port: number;
  models: string[];
  defaultModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  maxForwardCount: number; // N requests before returning fixed content
  logFile: string;
  presetsFile: string;
  enableJev: boolean;
  jevTimeoutMs: number;
  jevModel: string;
  targetTps: number;
  tpsJitter: number;
  maxStreamDurationSec: number;
}

const defaultModels = (process.env.MODELS || 'gpt5.5,gpt5.6,gpt5.6-sol,gpt6.1-sol,gpt6-astra')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

export const config: GatewayConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  models: defaultModels,
  defaultModel: process.env.MODEL || 'inclusionai/ling-3.1-flash',
  openaiBaseUrl: (process.env.OPENAI_BASEURL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  openaiApiKey: process.env.OPENAI_APIKEY || '',
  anthropicBaseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  anthropicApiKey: process.env.ANTHROPIC_APIKEY || '',
  maxForwardCount: parseInt(process.env.MAX_FORWARD_COUNT || process.env.N_REQUESTS || '3', 10),
  logFile: process.env.LOG_FILE || path.resolve(process.cwd(), 'logs/gateway.log'),
  presetsFile: process.env.PRESETS_FILE || path.resolve(process.cwd(), 'presets.json'),
  enableJev: process.env.ENABLE_JEV !== 'false',
  jevTimeoutMs: parseInt(process.env.JEV_TIMEOUT_MS || '2500', 10),
  jevModel: process.env.JEV_MODEL || 'typesafe/jev-1.13',
  targetTps: parseFloat(process.env.TARGET_TPS || process.env.TPS || '45'),
  tpsJitter: parseFloat(process.env.TPS_JITTER || '0.08'),
  maxStreamDurationSec: parseFloat(process.env.MAX_STREAM_DURATION_SEC || '25'),
};
