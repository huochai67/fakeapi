import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PresetRule } from './types.js';

interface CollectTask {
  id: string;
  name: string;
  prompt: string;
  patterns: string[];
  isRegex: boolean;
  hasCot: boolean;
  hasToolCall: boolean;
}

const tasks: CollectTask[] = [
  {
    id: 'probe_hi',
    name: 'Greeting Probe (hi)',
    prompt: 'hi',
    patterns: ['^\\s*hi\\s*$', '^\\s*hello\\s*$', '^\\s*hey\\s*$'],
    isRegex: true,
    hasCot: true,
    hasToolCall: false,
  },
  {
    id: 'probe_ping',
    name: 'Ping Probe (ping)',
    prompt: 'ping',
    patterns: ['^\\s*ping\\s*$'],
    isRegex: true,
    hasCot: true,
    hasToolCall: false,
  },
  {
    id: 'probe_pelican_bicycle',
    name: 'Pelican Bicycle Probe',
    prompt: 'pelican bicycle',
    patterns: ['pelican bicycle', 'pelican riding a bicycle'],
    isRegex: false,
    hasCot: true,
    hasToolCall: true,
  },
  {
    id: 'probe_response_ok',
    name: 'Response OK Probe',
    prompt: 'response ok',
    patterns: ['^\\s*response ok\\s*$', '^\\s*respond ok\\s*$'],
    isRegex: true,
    hasCot: false,
    hasToolCall: false,
  },
  {
    id: 'probe_cot_strawberry',
    name: 'Chain of Thought Reasoning Probe (strawberry)',
    prompt: 'How many r are in strawberry? Think step by step.',
    patterns: ['strawberry', 'how many r', 'think step by step', 'reasoning test', 'cot test'],
    isRegex: false,
    hasCot: true,
    hasToolCall: false,
  },
];

async function runOmpPrompt(prompt: string, model: string = 'antipro/gpt-6.1-sol'): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const proc = spawn('omp', ['--model', model, '--mode', 'json', '-p', prompt], {
    shell: false,
  });

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (data) => {
    stdout += data.toString();
  });
  proc.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  proc.on('close', (code) => {
    if (code === 0) {
      resolve(stdout);
    } else {
      reject(new Error(`omp exited with code ${code}: ${stderr}`));
    }
  });

  proc.on('error', (err) => {
    reject(err);
  });

  return promise;
}

export async function collectPresets(): Promise<void> {
  console.log('[Collector] Starting headless omp collection with model antipro/gpt-6.1-sol...');
  const rules: PresetRule[] = [];

  for (const task of tasks) {
    console.log(`[Collector] Collecting prompt: "${task.prompt}"...`);
    try {
      const output = await runOmpPrompt(task.prompt);
      const lines = output.split('\n').filter(Boolean);

      let text = '';
      let thinking = '';
      let thinkingSignature = '';
      let toolCallName = '';
      let toolCallArgs: Record<string, unknown> = {};
      let inputTokens = 2048;
      let outputTokens = 50;
      let cacheRead = 2560;
      let reasoningTokens = 0;

      for (const line of lines) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== 'object' || parsed === null) continue;
          const evt = parsed as Record<string, unknown>;

          if (evt.type === 'message_end' && typeof evt.message === 'object' && evt.message !== null) {
            const msg = evt.message as Record<string, unknown>;
            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
              for (const c of msg.content) {
                if (typeof c !== 'object' || c === null) continue;
                const block = c as Record<string, unknown>;

                if (block.type === 'thinking') {
                  if (typeof block.thinking === 'string') thinking = block.thinking;
                  if (typeof block.thinkingSignature === 'string') thinkingSignature = block.thinkingSignature;
                } else if (block.type === 'text') {
                  if (typeof block.text === 'string') text = block.text;
                } else if (block.type === 'toolCall') {
                  if (typeof block.name === 'string') toolCallName = block.name;
                  if (typeof block.arguments === 'object' && block.arguments !== null) {
                    toolCallArgs = block.arguments as Record<string, unknown>;
                  }
                }
              }

              if (typeof msg.usage === 'object' && msg.usage !== null) {
                const u = msg.usage as Record<string, unknown>;
                if (typeof u.input === 'number') inputTokens = u.input;
                if (typeof u.output === 'number') outputTokens = u.output;
                if (typeof u.cacheRead === 'number') cacheRead = u.cacheRead;
                if (typeof u.reasoningTokens === 'number') reasoningTokens = u.reasoningTokens;
              }
            }
          }
        } catch {
          // ignore non-json line
        }
      }

      const rule: PresetRule = {
        id: task.id,
        name: task.name,
        patterns: task.patterns,
        isRegex: task.isRegex,
        hasCot: task.hasCot,
        hasToolCall: task.hasToolCall,
        response: {
          text: text || (task.id === 'probe_ping' ? 'pong' : 'ok'),
          ...(thinking ? { thinking, thinkingSignature } : {}),
          ...(toolCallName ? { toolCall: { name: toolCallName, arguments: toolCallArgs } } : {}),
        },
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cached_tokens: cacheRead || 2560,
          reasoning_tokens: reasoningTokens,
        },
      };

      rules.push(rule);
      console.log(`[Collector] Collected rule ${task.id}: text="${rule.response.text.slice(0, 30)}...", cacheRead=${cacheRead}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Collector] Failed to collect "${task.prompt}": ${msg}`);
    }
  }

  // Load existing or default fixedRule
  const presetPath = path.resolve(process.cwd(), 'presets.json');
  let fixedRule: PresetRule = {
    id: 'fixed_after_n',
    name: 'Fixed Response After N Requests',
    patterns: [],
    hasCot: false,
    hasToolCall: false,
    response: {
      text: 'Fixed response: session limit reached.',
    },
    usage: {
      prompt_tokens: 1024,
      completion_tokens: 12,
      total_tokens: 1036,
      cached_tokens: 896,
      reasoning_tokens: 0,
    },
  };

  if (fs.existsSync(presetPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(presetPath, 'utf-8'));
      if (existing.fixedRule) fixedRule = existing.fixedRule;
    } catch {
      // ignore
    }
  }

  const outputPayload = {
    rules,
    fixedRule,
  };

  fs.writeFileSync(presetPath, JSON.stringify(outputPayload, null, 2));
  console.log(`[Collector] Saved ${rules.length} collected rules to ${presetPath}`);
}

// Direct execution
if (process.argv[1]?.endsWith('collector.ts') || process.argv[1]?.endsWith('collector.js')) {
  collectPresets().catch((err) => {
    console.error('[Collector] Error:', err);
    process.exit(1);
  });
}
