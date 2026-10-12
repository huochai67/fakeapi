import { Request, Response } from 'express';
import { AnthropicContentBlock, AnthropicMessagesRequest } from '../types.js';
import { stateStore } from '../state.js';
import { forwardToUpstream } from '../proxy.js';
import { logRequest } from '../logger.js';
import {
  generateAnthropicId,
  setRealisticAnthropicHeaders,
  buildAnthropicUsage,
  sleep,
  streamWithTpsPacing,
} from '../realistic.js';

export async function handleAnthropicMessages(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  const ip = stateStore.getClientIp(req);
  const body = req.body as AnthropicMessagesRequest;
  const requestedModel = body.model || 'claude-3-7-sonnet';
  const isStream = Boolean(body.stream);

  // Extract prompt text from messages
  let promptText = '';
  if (Array.isArray(body.messages)) {
    const userMessages = body.messages.filter(m => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    if (lastUser) {
      if (typeof lastUser.content === 'string') {
        promptText = lastUser.content;
      } else if (Array.isArray(lastUser.content)) {
        promptText = (lastUser.content as AnthropicContentBlock[])
          .map(b => b.text || '')
          .join(' ');
      }
    }
  }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const { turn, action, matchedRule } = await stateStore.evaluateRequest(ip, promptText, hasTools);

  if (action.type === 'forward') {
    await forwardToUpstream({
      ip,
      turn,
      clientModel: requestedModel,
      endpoint: 'messages',
      body: req.body as Record<string, unknown>,
      res,
      startTime,
    });
    return;
  }

  // Handle Preset or Fixed response
  const rule = action.rule;
  const messageId = generateAnthropicId();
  const usage = buildAnthropicUsage(rule.usage);
  const shouldDoToolCall = Boolean(rule.hasToolCall && rule.response.toolCall && hasTools);

  const contentBlocks: AnthropicContentBlock[] = [];

  if (rule.hasCot && rule.response.thinking) {
    contentBlocks.push({
      type: 'thinking',
      thinking: rule.response.thinking,
      signature: rule.response.thinkingSignature || 'sig_' + messageId.slice(4),
    });
  }

  if (shouldDoToolCall && rule.response.toolCall) {
    contentBlocks.push({
      type: 'tool_use',
      id: `toolu_${generateAnthropicId().slice(4, 18)}`,
      name: rule.response.toolCall.name,
      input: rule.response.toolCall.arguments,
    });
  } else {
    contentBlocks.push({
      type: 'text',
      text: rule.response.text,
    });
  }

  const stopReason = shouldDoToolCall ? 'tool_use' : 'end_turn';

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    setRealisticAnthropicHeaders(res, 250);

    await sleep(180 + Math.floor(Math.random() * 120));

    // event: message_start
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: requestedModel,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: usage.cache_read_input_tokens,
        },
      },
    })}\n\n`);

    let blockIndex = 0;

    // Stream thinking block
    if (rule.hasCot && rule.response.thinking) {
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'thinking',
          thinking: '',
        },
      })}\n\n`);

      for await (const part of streamWithTpsPacing(rule.response.thinking)) {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'thinking_delta',
            thinking: part,
          },
        })}\n\n`);
      }
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: blockIndex,
      })}\n\n`);

      blockIndex++;
    }

    // Stream tool_use or text block
    if (shouldDoToolCall && rule.response.toolCall) {
      const toolId = `toolu_${generateAnthropicId().slice(4, 18)}`;
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'tool_use',
          id: toolId,
          name: rule.response.toolCall.name,
          input: {},
        },
      })}\n\n`);

      const jsonStr = JSON.stringify(rule.response.toolCall.arguments);
      for await (const part of streamWithTpsPacing(jsonStr)) {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: part,
          },
        })}\n\n`);
      }
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: blockIndex,
      })}\n\n`);
    } else {
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'text',
          text: '',
        },
      })}\n\n`);

      const text = rule.response.text;
      for await (const part of streamWithTpsPacing(rule.response.text)) {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'text_delta',
            text: part,
          },
        })}\n\n`);
      }
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: blockIndex,
      })}\n\n`);
    }

    // message_delta
    res.write(`event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: {
        output_tokens: usage.output_tokens,
      },
    })}\n\n`);

    // message_stop
    res.write(`event: message_stop\ndata: ${JSON.stringify({
      type: 'message_stop',
    })}\n\n`);

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
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      cachedTokens: usage.cache_read_input_tokens,
      status: 200,
    });
    return;
  }

  // Non-streaming response
  await sleep(180 + Math.floor(Math.random() * 120));
  const durationMs = Date.now() - startTime;
  setRealisticAnthropicHeaders(res, durationMs);

  const responsePayload = {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
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
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    cachedTokens: usage.cache_read_input_tokens,
    status: 200,
  });

  res.json(responsePayload);
}
