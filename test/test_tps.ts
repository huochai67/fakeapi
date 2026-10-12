import http from 'http';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { estimateTokens } from '../src/realistic.js';

async function testTps(): Promise<void> {
  const app = createApp();
  const testPort = 3198;
  const { promise: serverStarted, resolve: resolveStart } = Promise.withResolvers<void>();
  const server = app.listen(testPort, () => resolveStart());
  await serverStarted;

  console.log(`[TPS Test] Configured TARGET_TPS: ${config.targetTps}`);

  // Test streaming Strawberry probe
  const reqData = JSON.stringify({
    model: 'gpt-6.1-sol',
    messages: [{ role: 'user', content: 'strawberry' }],
    stream: true,
  });

  const { promise: reqDone, resolve: resolveReq, reject: rejectReq } = Promise.withResolvers<{
    tps: number;
    tokens: number;
    durationSec: number;
    chunksCount: number;
  }>();

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: testPort,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '10.99.99.99',
      },
    },
    (res) => {
      let firstChunkTime = 0;
      let lastChunkTime = 0;
      let totalTokens = 0;
      let chunksCount = 0;

      res.on('data', (buf: Buffer) => {
        const text = buf.toString();
        const now = performance.now();
        if (!firstChunkTime) firstChunkTime = now;
        lastChunkTime = now;

        const lines = text.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            const delta = parsed.choices?.[0]?.delta;
            const content = delta?.content || delta?.reasoning_content;
            if (content) {
              totalTokens += estimateTokens(content);
              chunksCount++;
            }
          } catch {
            // ignore non-json
          }
        }
      });

      res.on('end', () => {
        const streamDurationSec = (lastChunkTime - firstChunkTime) / 1000;
        const tps = streamDurationSec > 0 ? totalTokens / streamDurationSec : 0;
        resolveReq({ tps, tokens: totalTokens, durationSec: streamDurationSec, chunksCount });
      });
    }
  );

  req.on('error', (err) => rejectReq(err));
  req.write(reqData);
  req.end();

  const result = await reqDone;
  server.close();

  console.log(`[TPS Test Results]`);
  console.log(`- Total Emitted Tokens: ${result.tokens}`);
  console.log(`- Chunks Emitted: ${result.chunksCount}`);
  console.log(`- Streaming Duration: ${result.durationSec.toFixed(3)}s`);
  console.log(`- Measured Live TPS: ${result.tps.toFixed(2)} tokens/sec`);
  console.log(`- Target TPS: ${config.targetTps} tokens/sec`);
  const diffPct = Math.abs(result.tps - config.targetTps) / config.targetTps * 100;
  console.log(`- Deviation: ${diffPct.toFixed(1)}%`);

  if (diffPct > 20) {
    throw new Error(`TPS deviation too high: ${diffPct.toFixed(1)}%`);
  }
  console.log('✓ TPS is rock-solid and stable within target tolerance!');
}

testTps().catch((err) => {
  console.error('[TPS Test] Failed:', err);
  process.exit(1);
});
