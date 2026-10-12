import { Request, Response } from 'express';
import { OpenAIChatRequest, OpenAIToolCall, PresetRule } from '../types.js';
import { stateStore } from '../state.js';
import { forwardToUpstream } from '../proxy.js';
import { logRequest } from '../logger.js';
import {
  generateOpenAIId,
  setRealisticOpenAIHeaders,
  buildOpenAIUsage,
  sleep,
  streamWithTpsPacing,
} from '../realistic.js';

export async function handleOpenAIChat(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  const ip = stateStore.getClientIp(req);
  const body = req.body as OpenAIChatRequest;
  const requestedModel = body.model || 'gpt-5.6-sol';
  const isStream = Boolean(body.stream);

  // Extract prompt text from messages
  let promptText = '';
  if (Array.isArray(body.messages)) {
    const userMessages = body.messages.filter(m => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    if (lastUser && typeof lastUser.content === 'string') {
      promptText = lastUser.content;
    } else if (lastUser && Array.isArray(lastUser.content)) {
      promptText = (lastUser.content as Array<{ type?: string; text?: string }>)
        .map(c => c.text || '')
        .join(' ');
    }
  }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const { turn, action, matchedRule } = await stateStore.evaluateRequest(ip, promptText, hasTools);

  if (action.type === 'forward') {
    await forwardToUpstream({
      ip,
      turn,
      clientModel: requestedModel,
      endpoint: 'chat',
      body: req.body as Record<string, unknown>,
      res,
      startTime,
    });
    return;
  }

  // Handle Preset or Fixed response
  const rule = action.rule;
  const shouldDoToolCall = Boolean(rule.hasToolCall && rule.response.toolCall && hasTools);

  let toolCalls: OpenAIToolCall[] | undefined;
  if (shouldDoToolCall && rule.response.toolCall) {
    toolCalls = [
      {
        id: `call_${generateOpenAIId('').slice(9)}`,
        type: 'function',
        function: {
          name: rule.response.toolCall.name,
          arguments: JSON.stringify(rule.response.toolCall.arguments),
        },
      },
    ];
  }

  const responseId = generateOpenAIId();
  const created = Math.floor(Date.now() / 1000);
  const usage = buildOpenAIUsage(rule.usage);

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    setRealisticOpenAIHeaders(res, requestedModel, 250);

    // Realistic TTFT delay
    await sleep(180 + Math.floor(Math.random() * 120));

    // Initial role chunk
    const initChunk = {
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model: requestedModel,
      system_fingerprint: 'fp_016ac62a',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(initChunk)}\n\n`);

    // Emit CoT reasoning chunks if present
    if (rule.hasCot && rule.response.thinking) {
      for await (const part of streamWithTpsPacing(rule.response.thinking)) {
        const reasoningChunk = {
          id: responseId,
          object: 'chat.completion.chunk',
          created,
          model: requestedModel,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: part },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
      }
    }

    // Emit tool calls or text content chunks
    if (toolCalls && toolCalls.length > 0) {
      const tc = toolCalls[0];
      const tcStartChunk = {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model: requestedModel,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.function.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(tcStartChunk)}\n\n`);

      for await (const part of streamWithTpsPacing(tc.function.arguments)) {
        const tcArgChunk = {
          id: responseId,
          object: 'chat.completion.chunk',
          created,
          model: requestedModel,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: part },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(tcArgChunk)}\n\n`);
      }

      // Finish tool call
      const finishChunk = {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model: requestedModel,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      };
      res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
    } else {
      // Stream text content
      for await (const part of streamWithTpsPacing(rule.response.text)) {
        const textChunk = {
          id: responseId,
          object: 'chat.completion.chunk',
          created,
          model: requestedModel,
          choices: [
            {
              index: 0,
              delta: { content: part },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
      }
      // Finish text
      const finishChunk = {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model: requestedModel,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      };
      res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
    }

    // Stream usage chunk
    const usageChunk = {
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model: requestedModel,
      choices: [],
      usage,
    };
    res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

    const durationMs = Date.now() - startTime;
    logRequest({
      ip,
      method: 'POST',
      path: req.path,
      model: requestedModel,
      turn,
      action: action.type === 'preset' ? 'preset_hit_stream' : 'fixed_canned_stream',
      matchedRule: matchedRule?.name,
      stream: true,
      durationMs,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cachedTokens: usage.prompt_tokens_details.cached_tokens,
      reasoningTokens: usage.completion_tokens_details.reasoning_tokens,
      status: 200,
    });
    return;
  }

  // Non-streaming response
  await sleep(180 + Math.floor(Math.random() * 120));
  const durationMs = Date.now() - startTime;
  setRealisticOpenAIHeaders(res, requestedModel, durationMs);

  const responsePayload = {
    id: responseId,
    object: 'chat.completion',
    created,
    model: requestedModel,
    system_fingerprint: 'fp_016ac62a',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: toolCalls ? null : rule.response.text,
          ...(rule.hasCot && rule.response.thinking ? { reasoning_content: rule.response.thinking } : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage,
  };

  logRequest({
    ip,
    method: 'POST',
    path: req.path,
    model: requestedModel,
    turn,
    action: action.type === 'preset' ? 'preset_hit' : 'fixed_canned',
    matchedRule: matchedRule?.name,
    stream: false,
    durationMs,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    cachedTokens: usage.prompt_tokens_details.cached_tokens,
    reasoningTokens: usage.completion_tokens_details.reasoning_tokens,
    status: 200,
  });

  res.json(responsePayload);
}
