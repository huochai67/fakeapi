import { Request, Response } from 'express';
import { OpenAIResponsesRequest } from '../types.js';
import { stateStore } from '../state.js';
import { forwardToUpstream } from '../proxy.js';
import { logRequest } from '../logger.js';
import {
  generateOpenAIId,
  setRealisticOpenAIHeaders,
  buildResponsesUsage,
  sleep,
  streamWithTpsPacing,
} from '../realistic.js';

export async function handleOpenAIResponses(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  const ip = stateStore.getClientIp(req);
  const body = req.body as OpenAIResponsesRequest;
  const requestedModel = body.model || 'gpt-6.1-sol';
  const isStream = Boolean(body.stream);

  // Extract prompt text from input
  let promptText = '';
  if (typeof body.input === 'string') {
    promptText = body.input;
  } else if (Array.isArray(body.input)) {
    promptText = body.input
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null) {
          const content = (item as Record<string, unknown>).content;
          return typeof content === 'string' ? content : JSON.stringify(content);
        }
        return '';
      })
      .join(' ');
  }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const { turn, action, matchedRule } = await stateStore.evaluateRequest(ip, promptText, hasTools);

  if (action.type === 'forward') {
    await forwardToUpstream({
      ip,
      turn,
      clientModel: requestedModel,
      endpoint: 'responses',
      body: req.body as Record<string, unknown>,
      res,
      startTime,
    });
    return;
  }

  // Handle Preset or Fixed response
  const rule = action.rule;
  const responseId = generateOpenAIId('resp_');
  const now = Math.floor(Date.now() / 1000);
  const usage = buildResponsesUsage(rule.usage);

  const shouldDoToolCall = Boolean(rule.hasToolCall && rule.response.toolCall && hasTools);
  const outputItems: Record<string, unknown>[] = [];

  if (rule.hasCot && rule.response.thinking) {
    outputItems.push({
      id: generateOpenAIId('rs_'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: rule.response.thinking.trim() }],
      content: [],
    });
  }

  if (shouldDoToolCall && rule.response.toolCall) {
    outputItems.push({
      id: generateOpenAIId('call_'),
      type: 'function_call',
      call_id: generateOpenAIId('call_'),
      name: rule.response.toolCall.name,
      arguments: JSON.stringify(rule.response.toolCall.arguments),
      status: 'completed',
    });
  } else {
    outputItems.push({
      id: generateOpenAIId('msg_'),
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: rule.response.text,
        },
      ],
      status: 'completed',
    });
  }

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    setRealisticOpenAIHeaders(res, requestedModel, 250);

    await sleep(180 + Math.floor(Math.random() * 120));

    // 1. response.created
    res.write(`event: response.created\ndata: ${JSON.stringify({
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: now,
        status: 'in_progress',
        model: requestedModel,
        output: [],
      },
    })}\n\n`);

    let outputIdx = 0;

    // 2. If CoT reasoning present, emit reasoning item
    if (rule.hasCot && rule.response.thinking) {
      const reasoningId = generateOpenAIId('rs_');
      res.write(`event: response.output_item.added\ndata: ${JSON.stringify({
        type: 'response.output_item.added',
        output_index: outputIdx,
        item: {
          id: reasoningId,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: rule.response.thinking.trim() }],
          content: [],
        },
      })}\n\n`);

      res.write(`event: response.output_item.done\ndata: ${JSON.stringify({
        type: 'response.output_item.done',
        output_index: outputIdx,
        item: {
          id: reasoningId,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: rule.response.thinking.trim() }],
          content: [],
        },
      })}\n\n`);
      outputIdx++;
    }

    // 3. Output message item
    const msgId = generateOpenAIId('msg_');
    res.write(`event: response.output_item.added\ndata: ${JSON.stringify({
      type: 'response.output_item.added',
      output_index: outputIdx,
      item: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '' }],
        status: 'in_progress',
      },
    })}\n\n`);

    for await (const part of streamWithTpsPacing(rule.response.text)) {
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
        type: 'response.output_text.delta',
        output_index: outputIdx,
        content_index: 0,
        delta: part,
      })}\n\n`);
    }

    res.write(`event: response.output_item.done\ndata: ${JSON.stringify({
      type: 'response.output_item.done',
      output_index: outputIdx,
      item: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: rule.response.text }],
        status: 'completed',
      },
    })}\n\n`);

    // 4. Terminal event: response.completed & response.done
    const terminalPayload = {
      id: responseId,
      object: 'response',
      created_at: now,
      status: 'completed',
      model: requestedModel,
      output: outputItems,
      usage,
    };

    res.write(`event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: terminalPayload,
    })}\n\n`);

    res.write(`event: response.done\ndata: ${JSON.stringify({
      type: 'response.done',
      response: terminalPayload,
    })}\n\n`);

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
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      cachedTokens: usage.input_token_details.cached_tokens,
      reasoningTokens: usage.output_token_details.reasoning_tokens,
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
    object: 'response',
    created_at: now,
    status: 'completed',
    model: requestedModel,
    output: outputItems,
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
    cachedTokens: usage.input_token_details.cached_tokens,
    reasoningTokens: usage.output_token_details.reasoning_tokens,
    status: 200,
  });

  res.json(responsePayload);
}
