import { config } from './config.js';
import { PresetRule } from './types.js';
import { loadPresets } from './presets.js';

interface JevDecisionsResponse {
  answers?: {
    is_probe?: {
      type: string;
      noul: number;
    };
    matched_category?: {
      type: string;
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    };
  };
}

export interface JevMatchResult {
  rule: PresetRule | null;
  available: boolean;
  reason?: string;
}

export async function matchPresetWithJev(promptText: string): Promise<JevMatchResult> {
  if (!config.enableJev || !config.openaiApiKey) {
    return { rule: null, available: false, reason: 'jev_disabled_or_no_key' };
  }

  const trimmed = promptText.trim();
  if (trimmed.length === 0 || trimmed.length > 5000) {
    return { rule: null, available: true, reason: 'prompt_empty_or_too_long' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.jevTimeoutMs);

  try {
    const presets = loadPresets();
    const criteria: Record<string, string> = {
      none: 'Standard normal conversation or development task, not testing model capability or benchmark probes.',
      probe_pelican_svg: 'Classic Pelican bicycle SVG benchmark (e.g. Generate an SVG of a pelican riding a bicycle or variants).',
      probe_candy_drawer: 'The 3-flavor 2-shape candy drawer pigeonhole math problem (e.g. apple/peach/watermelon, circle/star, minimum candies guaranteed).',
      probe_enhanced_goose_svg: 'Enhanced composite benchmark (goose riding bicycle on Sun Wukong airplane wing, Qin Shi Huang on polar bear tightening screws, shouting candy result).',
      probe_hi: 'Simple greeting probe (hi, hello, hey).',
      probe_ping: 'Simple latency or ping connectivity check.',
      probe_response_ok: 'Simple test asking model to respond ok.',
      probe_cot_strawberry: 'Reasoning riddle like strawberry r letter counting.',
      probe_tool_call: 'Probe checking tool or function call execution.',
    };

    const payload = {
      model: config.jevModel,
      state: {
        user_prompt: trimmed,
      },
      questions: {
        is_probe: {
          type: 'noul',
          instructions: 'Is this query an LLM capability benchmark, IQ test prompt, or honeypot probe designed to test model spatial reasoning, math deduction, or API authenticity?',
          criteria: {
            true: 'A benchmark test, IQ test prompt, or authenticity probe.',
            false: 'A genuine normal user request.',
          },
        },
        matched_category: {
          type: 'choice',
          instructions: 'Which specific benchmark probe or test category does this query belong to?',
          criteria,
        },
      },
    };

    const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return { rule: null, available: false, reason: `http_${res.status}` };
    }

    const data: unknown = await res.json();
    if (typeof data !== 'object' || data === null) {
      return { rule: null, available: false, reason: 'invalid_response_format' };
    }
    const jevRes = data as JevDecisionsResponse;

    const matchedCat = jevRes.answers?.matched_category;
    if (matchedCat && matchedCat.choice && matchedCat.choice !== 'none') {
      const prob = matchedCat.probabilities[matchedCat.choice] || 0;
      if (prob >= 0.6 && matchedCat.confidence >= 0.5) {
        const found = presets.rules.find((r) => r.id === matchedCat.choice);
        if (found) {
          return { rule: found, available: true, reason: 'jev_matched' };
        }
      }
    }

    return { rule: null, available: true, reason: 'jev_classified_none' };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    return { rule: null, available: false, reason: `exception: ${msg}` };
  }
}
