import crypto from 'crypto';
import { Response } from 'express';
import { config } from './config.js';
import { PresetRule, TokenUsage } from './types.js';

export function generateOpenAIId(prefix: string = 'chatcmpl-'): string {
  return `${prefix}${crypto.randomBytes(14).toString('hex')}`;
}

export function generateAnthropicId(): string {
  return `msg_${crypto.randomBytes(16).toString('hex')}`;
}

export function generateCfRay(): string {
  return `${crypto.randomBytes(8).toString('hex')}-SJC`;
}

export function setRealisticOpenAIHeaders(res: Response, model: string, durationMs: number): void {
  res.setHeader('x-request-id', `req_${crypto.randomBytes(16).toString('hex')}`);
  res.setHeader('openai-processing-ms', String(Math.max(durationMs, 180 + Math.floor(Math.random() * 120))));
  res.setHeader('openai-version', '2020-10-01');
  res.setHeader('openai-model', model);
  res.setHeader('cf-ray', generateCfRay());
  res.setHeader('cf-cache-status', 'DYNAMIC');
  res.setHeader('server', 'cloudflare');
  res.setHeader('access-control-allow-origin', '*');
}

export function setRealisticAnthropicHeaders(res: Response, durationMs: number): void {
  const reqId = `req_${crypto.randomBytes(16).toString('hex')}`;
  res.setHeader('request-id', reqId);
  res.setHeader('anthropic-ratelimit-requests-limit', '50');
  res.setHeader('anthropic-ratelimit-requests-remaining', '49');
  res.setHeader('anthropic-ratelimit-requests-reset', '2026-10-07T12:00:00Z');
  res.setHeader('anthropic-ratelimit-tokens-limit', '100000');
  res.setHeader('anthropic-ratelimit-tokens-remaining', '98500');
  res.setHeader('anthropic-ratelimit-tokens-reset', '2026-10-07T12:00:00Z');
  res.setHeader('cf-ray', generateCfRay());
  res.setHeader('cf-cache-status', 'DYNAMIC');
  res.setHeader('server', 'cloudflare');
  res.setHeader('access-control-allow-origin', '*');
}

export function buildOpenAIUsage(usage: PresetRule['usage']) {
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens),
    prompt_tokens_details: {
      cached_tokens: usage.cached_tokens,
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: usage.reasoning_tokens || 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  };
}

export function buildAnthropicUsage(usage: PresetRule['usage']) {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: usage.cached_tokens,
  };
}

export function buildResponsesUsage(usage: PresetRule['usage']) {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens),
    input_token_details: {
      cached_tokens: usage.cached_tokens,
    },
    output_token_details: {
      reasoning_tokens: usage.reasoning_tokens || 0,
    },
  };
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) {
      tokens += 1.2;
    } else {
      tokens += 0.28;
    }
  }
  return Math.max(1, Math.round(tokens));
}

export function sliceIntoTokens(text: string): string[] {
  const re = /[A-Za-z0-9]+|[\u4e00-\u9fa5]|\s+|[^\s\w\u4e00-\u9fa5]/g;
  return text.match(re) || [text];
}

export async function* streamWithTpsPacing(
  text: string,
  overrideTps?: number
): AsyncGenerator<string, void, unknown> {
  const chunks = sliceIntoTokens(text);
  let totalEstimatedTokens = 0;
  for (const c of chunks) {
    totalEstimatedTokens += estimateTokens(c);
  }

  const baseTps = overrideTps || config.targetTps;
  // If text is massive, scale TPS smoothly so stream finishes within maxStreamDurationSec
  const minTpsForDuration = totalEstimatedTokens / Math.max(config.maxStreamDurationSec, 5);
  const effectiveTps = Math.max(baseTps, minTpsForDuration);

  const startTime = performance.now();
  let emittedTokens = 0;

  for (const chunk of chunks) {
    emittedTokens += estimateTokens(chunk);
    yield chunk;

    const targetElapsedMs = (emittedTokens / effectiveTps) * 1000;
    const currentElapsedMs = performance.now() - startTime;
    const delayNeeded = targetElapsedMs - currentElapsedMs;

    const maxJitterMs = (1000 / effectiveTps) * config.tpsJitter;
    const jitterMs = (Math.random() - 0.5) * maxJitterMs * 2;
    const sleepMs = Math.max(0, delayNeeded + jitterMs);

    if (sleepMs > 2) {
      await sleep(sleepMs);
    }
  }
}
