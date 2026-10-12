import { Response } from 'express';
import { config } from './config.js';
import { logRequest } from './logger.js';

export interface ProxyOptions {
  ip: string;
  turn: number;
  clientModel: string;
  endpoint: 'chat' | 'responses' | 'messages';
  body: Record<string, unknown>;
  res: Response;
  startTime: number;
}

export async function forwardToUpstream(options: ProxyOptions): Promise<void> {
  const { ip, turn, clientModel, endpoint, body, res, startTime } = options;
  const isStream = Boolean(body.stream);

  // Map model to default upstream model if needed
  const upstreamBody: Record<string, unknown> = {
    ...body,
    model: config.defaultModel,
  };

  let targetUrl = '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (endpoint === 'messages') {
    // Anthropic protocol
    targetUrl = `${config.anthropicBaseUrl}/messages`;
    // If upstream is OpenRouter or standard Anthropic
    if (config.anthropicApiKey) {
      if (config.anthropicBaseUrl.includes('openrouter.ai')) {
        headers['Authorization'] = `Bearer ${config.anthropicApiKey}`;
      } else {
        headers['x-api-key'] = config.anthropicApiKey;
        headers['anthropic-version'] = '2023-06-01';
      }
    }
  } else if (endpoint === 'responses') {
    // OpenAI Responses API
    // If upstream doesn't support /responses, fallback to chat/completions translation
    targetUrl = `${config.openaiBaseUrl}/responses`;
    if (config.openaiApiKey) {
      headers['Authorization'] = `Bearer ${config.openaiApiKey}`;
    }
  } else {
    // OpenAI Chat Completions
    targetUrl = `${config.openaiBaseUrl}/chat/completions`;
    if (config.openaiApiKey) {
      headers['Authorization'] = `Bearer ${config.openaiApiKey}`;
    }
  }

  try {
    let upstreamRes = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
    });

    // If upstream /responses 404s, attempt chat/completions fallback for OpenAI Responses
    if (endpoint === 'responses' && upstreamRes.status === 404) {
      const fallbackUrl = `${config.openaiBaseUrl}/chat/completions`;
      const promptInput = typeof body.input === 'string'
        ? body.input
        : JSON.stringify(body.input);
      const chatFallbackBody = {
        model: config.defaultModel,
        messages: [{ role: 'user', content: promptInput }],
        stream: isStream,
      };
      upstreamRes = await fetch(fallbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(chatFallbackBody),
      });
    }
    // If primary model hit 429 upstream rate limit, retry once with fallback model
    if (upstreamRes.status === 429 && config.defaultModel !== 'liquid/lfm-2.5-2.6b:free') {
      const retryBody = {
        ...upstreamBody,
        model: 'liquid/lfm-2.5-2.6b:free',
      };
      const retryRes = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(retryBody),
      });
      if (retryRes.ok) {
        upstreamRes = retryRes;
      }
    }
    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      const durationMs = Date.now() - startTime;
      logRequest({
        ip,
        method: 'POST',
        path: targetUrl,
        model: clientModel,
        turn,
        action: 'upstream_error',
        stream: isStream,
        durationMs,
        status: upstreamRes.status,
        error: errText.slice(0, 200),
      });
      res.status(upstreamRes.status).send(errText);
      return;
    }

    if (isStream && upstreamRes.body) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let streamBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkText = decoder.decode(value, { stream: true });
        // Replace upstream model name with client's requested model name in chunks
        const modifiedChunk = chunkText.replaceAll(config.defaultModel, clientModel);
        res.write(modifiedChunk);
        streamBuffer += chunkText;
      }
      res.end();

      const durationMs = Date.now() - startTime;
      logRequest({
        ip,
        method: 'POST',
        path: `upstream (${endpoint})`,
        model: clientModel,
        turn,
        action: `turn_${turn}_real_forward`,
        stream: true,
        durationMs,
        status: 200,
      });
      return;
    }

    // Non-streaming response
    const json: unknown = await upstreamRes.json();
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;

    if (typeof json === 'object' && json !== null) {
      const resultObj = json as Record<string, unknown>;
      // Rewrite model to what client requested
      resultObj.model = clientModel;

      // Ensure realistic cached tokens exist in usage
      if (typeof resultObj.usage === 'object' && resultObj.usage !== null) {
        const usage = resultObj.usage as Record<string, unknown>;
        promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0);
        completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0);
        
        // If cached tokens not set, add realistic cache tokens
        if (typeof usage.prompt_tokens_details !== 'object') {
          const simulatedCache = Math.floor(promptTokens * 0.6);
          cachedTokens = simulatedCache;
          usage.prompt_tokens_details = {
            cached_tokens: simulatedCache,
            audio_tokens: 0,
          };
        } else {
          const details = usage.prompt_tokens_details as Record<string, unknown>;
          cachedTokens = typeof details.cached_tokens === 'number' ? details.cached_tokens : 0;
        }

        if (endpoint === 'messages') {
          const simCache = typeof usage.cache_read_input_tokens === 'number'
            ? usage.cache_read_input_tokens
            : Math.floor(promptTokens * 0.6);
          usage.cache_read_input_tokens = simCache;
          cachedTokens = simCache;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    logRequest({
      ip,
      method: 'POST',
      path: `upstream (${endpoint})`,
      model: clientModel,
      turn,
      action: `turn_${turn}_real_forward`,
      stream: false,
      durationMs,
      promptTokens,
      completionTokens,
      cachedTokens,
      status: 200,
    });

    res.json(json);
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logRequest({
      ip,
      method: 'POST',
      path: `upstream (${endpoint})`,
      model: clientModel,
      turn,
      action: 'upstream_exception',
      stream: isStream,
      durationMs,
      status: 502,
      error: errorMsg,
    });
    res.status(502).json({
      error: {
        message: `Upstream error: ${errorMsg}`,
        type: 'gateway_upstream_error',
      },
    });
  }
}
