import http from 'http';
import fs from 'fs';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { stateStore } from '../src/state.js';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function request(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>
): Promise<{ status: number; headers: Record<string, string>; json: Record<string, unknown>; text: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    headers: Record<string, string>;
    json: Record<string, unknown>;
    text: string;
  }>();

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(data);
        } catch {
          // not json
        }
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') respHeaders[k] = v;
        }
        resolve({
          status: res.statusCode || 0,
          headers: respHeaders,
          json: parsed,
          text: data,
        });
      });
    }
  );

  req.on('error', (err) => {
    reject(err);
  });

  if (body) {
    req.write(JSON.stringify(body));
  }
  req.end();

  return promise;
}

async function runTests(): Promise<void> {
  const app = createApp();
  const testPort = 3199;
  const { promise: serverStarted, resolve: resolveStart } = Promise.withResolvers<void>();
  const server = app.listen(testPort, () => {
    resolveStart();
  });
  await serverStarted;
  console.log(`[Test] Server started on port ${testPort}`);

  stateStore.reset();

  // Test 1: Models endpoint
  try {
    const res = await request(testPort, '/v1/models', 'GET', {});
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    const data = res.json.data;
    assert(Array.isArray(data), 'res.data should be array');
    const modelIds = (data as Array<{ id: string }>).map((m) => m.id);
    for (const m of config.models) {
      assert(modelIds.includes(m), `Model ${m} should be listed`);
    }
    results.push({ name: 'GET /v1/models lists configured models', passed: true });
    console.log('✓ GET /v1/models passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'GET /v1/models', passed: false, error: msg });
    console.error('✗ GET /v1/models failed:', msg);
  }

  // Test 2: Anti-probe Client A - Turn 1: probe hit "hi"
  try {
    const res = await request(
      testPort,
      '/v1/chat/completions',
      'POST',
      { 'x-forwarded-for': '10.0.0.1' },
      {
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'hi' }],
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    const choices = res.json.choices as Array<{ message: { content: string; reasoning_content?: string } }>;
    assert(Array.isArray(choices) && choices.length > 0, 'choices should exist');
    assert(choices[0].message.content.includes('Hi. What would you like to work on?'), 'content matches preset');
    assert(Boolean(choices[0].message.reasoning_content), 'reasoning_content (CoT) exists');
    const usage = res.json.usage as { prompt_tokens_details: { cached_tokens: number } };
    assert(usage.prompt_tokens_details.cached_tokens === 2560, 'cached_tokens should be 2560');
    assert(Boolean(res.headers['openai-processing-ms']), 'openai-processing-ms header exists');
    assert(Boolean(res.headers['cf-ray']), 'cf-ray header exists');
    results.push({ name: 'Turn 1: Probe hit "hi" returns preset with CoT and cache tokens', passed: true });
    console.log('✓ Turn 1: Probe hit "hi" passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'Turn 1 probe hit', passed: false, error: msg });
    console.error('✗ Turn 1 probe hit failed:', msg);
  }

  // Test 3: Anti-probe Client A - Turn 2: real forward to upstream
  try {
    const res = await request(
      testPort,
      '/v1/chat/completions',
      'POST',
      { 'x-forwarded-for': '10.0.0.1' },
      {
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'What is 2+2? Reply only the number.' }],
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    assert(res.json.model === 'gpt-6.1-sol', 'model rewritten to requested model');
    const choices = res.json.choices as Array<{ message: { content: string } }>;
    assert(Array.isArray(choices) && choices.length > 0, 'choices should exist');
    assert(choices[0].message.content.includes('4'), `real upstream response contains 4: ${choices[0].message.content}`);
    results.push({ name: 'Turn 2: Real forward to upstream returns authentic answer', passed: true });
    console.log('✓ Turn 2: Real forward passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'Turn 2 real forward', passed: false, error: msg });
    console.error('✗ Turn 2 real forward failed:', msg);
  }

  // Test 4: Anti-probe Client A - Turn 3: real forward to upstream (within maxForwardCount=3)
  try {
    const res = await request(
      testPort,
      '/v1/chat/completions',
      'POST',
      { 'x-forwarded-for': '10.0.0.1' },
      {
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Say hello in French. One word.' }],
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    results.push({ name: 'Turn 3: Real forward within N requests limit', passed: true });
    console.log('✓ Turn 3: Real forward passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'Turn 3 real forward', passed: false, error: msg });
    console.error('✗ Turn 3 real forward failed:', msg);
  }

  // Test 5: Anti-probe Client A - Turn 4 (> N): returns fixed response
  try {
    const res = await request(
      testPort,
      '/v1/chat/completions',
      'POST',
      { 'x-forwarded-for': '10.0.0.1' },
      {
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Any question' }],
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    const choices = res.json.choices as Array<{ message: { content: string } }>;
    assert(choices[0].message.content.includes('Fixed response'), `Turn > N returns fixed canned content: ${choices[0].message.content}`);
    results.push({ name: 'Turn 4 (> N): Returns fixed canned content', passed: true });
    console.log('✓ Turn 4: Fixed response passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'Turn 4 fixed response', passed: false, error: msg });
    console.error('✗ Turn 4 fixed response failed:', msg);
  }

  // Test 6: Client B - Turn 1 without match -> real forward
  try {
    const res = await request(
      testPort,
      '/v1/chat/completions',
      'POST',
      { 'x-forwarded-for': '10.0.0.2' },
      {
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'What is the color of the clear sky? One word.' }],
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    const choices = res.json.choices as Array<{ message: { content: string } }>;
    assert(choices[0].message.content.toLowerCase().includes('blue'), `Probe miss forwards to upstream: ${choices[0].message.content}`);
    results.push({ name: 'Turn 1 without probe match triggers real forward', passed: true });
    console.log('✓ Turn 1 probe miss passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'Turn 1 probe miss', passed: false, error: msg });
    console.error('✗ Turn 1 probe miss failed:', msg);
  }

  // Test 7: Client C - Tool call probe with tools enabled
  try {
    const res = await request(
      testPort,
      '/v1/chat/completions',
      'POST',
      { 'x-forwarded-for': '10.0.0.3' },
      {
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'call tool to check weather' }],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'Get weather' },
          },
        ],
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    const choices = res.json.choices as Array<{
      finish_reason: string;
      message: { tool_calls?: Array<{ function: { name: string } }> };
    }>;
    assert(choices[0].finish_reason === 'tool_calls', 'finish_reason should be tool_calls');
    assert(Boolean(choices[0].message.tool_calls), 'tool_calls exist');
    assert(choices[0].message.tool_calls?.[0]?.function.name === 'get_weather', 'tool name is get_weather');
    results.push({ name: 'Tool call probe returns tool_calls structure', passed: true });
    console.log('✓ Tool call probe passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'Tool call probe', passed: false, error: msg });
    console.error('✗ Tool call probe failed:', msg);
  }

  // Test 8: Client D - Streaming OpenAI chat completions
  try {
    const res = await request(
      testPort,
      '/v1/chat/completions',
      'POST',
      { 'x-forwarded-for': '10.0.0.4' },
      {
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    assert(res.headers['content-type']?.includes('text/event-stream'), 'Content-Type is event-stream');
    assert(res.text.includes('chat.completion.chunk'), 'Contains chat.completion.chunk');
    assert(res.text.includes('pong'), 'Contains stream delta text pong');
    assert(res.text.includes('[DONE]'), 'Ends with [DONE]');
    results.push({ name: 'Streaming OpenAI chat completions returns valid SSE chunks', passed: true });
    console.log('✓ Streaming OpenAI chat completions passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'Streaming OpenAI chat', passed: false, error: msg });
    console.error('✗ Streaming OpenAI chat failed:', msg);
  }

  // Test 9: Client E - Anthropic Messages API (/v1/messages)
  try {
    const res = await request(
      testPort,
      '/v1/messages',
      'POST',
      { 'x-forwarded-for': '10.0.0.5' },
      {
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'ping' }],
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    assert(res.json.type === 'message', 'type is message');
    assert(res.json.role === 'assistant', 'role is assistant');
    const content = res.json.content as Array<{ type: string; text?: string; thinking?: string }>;
    assert(Array.isArray(content), 'content is array');
    const textBlock = content.find((c) => c.type === 'text');
    assert(textBlock?.text === 'pong', 'text block is pong');
    const thinkingBlock = content.find((c) => c.type === 'thinking');
    assert(Boolean(thinkingBlock), 'thinking block present');
    const usage = res.json.usage as { cache_read_input_tokens: number };
    assert(usage.cache_read_input_tokens === 2560, 'cache_read_input_tokens is 2560');
    assert(Boolean(res.headers['anthropic-ratelimit-requests-limit']), 'Anthropic ratelimit headers present');
    results.push({ name: 'Anthropic Messages API (/v1/messages) returns valid Anthropic format with cache tokens', passed: true });
    console.log('✓ Anthropic Messages API passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'Anthropic Messages API', passed: false, error: msg });
    console.error('✗ Anthropic Messages API failed:', msg);
  }

  // Test 10: Client F - OpenAI Responses API (/v1/responses)
  try {
    const res = await request(
      testPort,
      '/v1/responses',
      'POST',
      { 'x-forwarded-for': '10.0.0.6' },
      {
        model: 'gpt-6.1-sol',
        input: 'response ok',
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    assert(res.json.object === 'response', 'object is response');
    assert(res.json.status === 'completed', 'status is completed');
    const output = res.json.output as Array<{
      type: string;
      content?: Array<{ type: string; text: string }>;
    }>;
    assert(Array.isArray(output), 'output is array');
    const msgItem = output.find((o) => o.type === 'message');
    assert(msgItem?.content?.[0]?.text === 'ok', 'output text is ok');
    const usage = res.json.usage as { input_token_details: { cached_tokens: number } };
    assert(usage.input_token_details.cached_tokens === 2560, 'cached_tokens is 2560');
    results.push({ name: 'OpenAI Responses API (/v1/responses) returns valid response format with cache tokens', passed: true });
    console.log('✓ OpenAI Responses API passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'OpenAI Responses API', passed: false, error: msg });
    console.error('✗ OpenAI Responses API failed:', msg);
  }

  // Test 11: Verify Gateway Log File
  try {
    assert(fs.existsSync(config.logFile), `Log file ${config.logFile} should exist`);
    const logContent = fs.readFileSync(config.logFile, 'utf-8');
    assert(logContent.includes('10.0.0.1'), 'Log contains IP 10.0.0.1');
    assert(logContent.includes('gpt-6.1-sol'), 'Log contains requested model');
    assert(logContent.includes('probe_hi') || logContent.includes('Greeting Probe'), 'Log contains matched hit content');
    results.push({ name: 'Log system records IP, model, and hit content', passed: true });
    console.log('✓ Log file verification passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'Log verification', passed: false, error: msg });
    console.error('✗ Log verification failed:', msg);
  }

  // Test 12: IQ Benchmark - Classic Pelican Riding a Bicycle SVG
  try {
    const res = await request(
      testPort,
      '/v1/chat/completions',
      'POST',
      { 'x-forwarded-for': '10.0.0.12' },
      {
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Generate an SVG of a pelican riding a bicycle.' }],
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    const choices = res.json.choices as Array<{ message: { content: string } }>;
    assert(choices[0].message.content.includes('<svg'), 'Response contains valid SVG markup');
    assert(choices[0].message.content.includes('pelican'), 'Response mentions pelican');
    results.push({ name: 'IQ Benchmark: Classic Pelican Bicycle SVG probe returns genuine SVG', passed: true });
    console.log('✓ IQ Benchmark: Pelican SVG passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'IQ Benchmark: Pelican SVG', passed: false, error: msg });
    console.error('✗ IQ Benchmark: Pelican SVG failed:', msg);
  }

  // Test 13: IQ Benchmark - Candy Pigeonhole Math Problem
  try {
    const res = await request(
      testPort,
      '/v1/chat/completions',
      'POST',
      { 'x-forwarded-for': '10.0.0.13' },
      {
        model: 'gpt-6.1-sol',
        messages: [{
          role: 'user',
          content: '不使用任何外部工具回答以下问题：在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求） 苹果味 桃子味 西瓜味 圆形 7 9 8 五角星形 7 6 4',
        }],
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    const choices = res.json.choices as Array<{ message: { content: string } }>;
    assert(choices[0].message.content.includes('21'), 'Response contains correct solution 21');
    results.push({ name: 'IQ Benchmark: Candy drawer pigeonhole problem returns authentic 21 solution', passed: true });
    console.log('✓ IQ Benchmark: Candy problem passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'IQ Benchmark: Candy problem', passed: false, error: msg });
    console.error('✗ IQ Benchmark: Candy problem failed:', msg);
  }

  // Test 14: IQ Benchmark - Enhanced Goose Plane Wing Qin Shi Huang Composite SVG
  try {
    const res = await request(
      testPort,
      '/v1/chat/completions',
      'POST',
      { 'x-forwarded-for': '10.0.0.14' },
      {
        model: 'gpt-6.1-sol',
        messages: [{
          role: 'user',
          content: '做一张新的精细的SVG图片，内容是鹅鹅骑着自行车在孙悟空开的大型飞机机翼上骑行， 鹅鹅展开翅膀，上面托着秦始皇的北极熊，秦始皇骑在熊上打螺丝。鹅鹅喊出“在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求） 苹果味 桃子味 西瓜味 圆形 7 9 8 五角星形 7 6 4” 的结果数值',
        }],
      }
    );
    assert(res.status === 200, `Status should be 200, got ${res.status}`);
    const choices = res.json.choices as Array<{ message: { content: string } }>;
    assert(choices[0].message.content.includes('<svg'), 'Composite SVG contains valid svg markup');
    assert(choices[0].message.content.includes('21'), 'Composite SVG shouts out answer 21');
    results.push({ name: 'IQ Benchmark: Enhanced Goose Wing Composite SVG probe returns fine SVG with 21', passed: true });
    console.log('✓ IQ Benchmark: Enhanced Goose Composite SVG passed');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: 'IQ Benchmark: Enhanced Goose Composite SVG', passed: false, error: msg });
    console.error('✗ IQ Benchmark: Enhanced Goose Composite SVG failed:', msg);
  }

  server.close();

  const failedCount = results.filter((r) => !r.passed).length;
  console.log(`\n================================`);
  console.log(`Test Summary: ${results.length - failedCount}/${results.length} passed.`);
  if (failedCount > 0) {
    console.error(`${failedCount} tests failed!`);
    process.exit(1);
  } else {
    console.log('All tests passed successfully!');
  }
}

runTests().catch((err) => {
  console.error('[Test] Fatal runner error:', err);
  process.exit(1);
});
