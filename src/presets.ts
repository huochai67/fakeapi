import fs from 'fs';
import { PresetRule } from './types.js';
import { config } from './config.js';

export interface PresetsConfig {
  rules: PresetRule[];
  fixedRule: PresetRule;
}

const defaultFixedRule: PresetRule = {
  id: 'fixed_default',
  name: 'Default Fixed Response',
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

let loadedRules: PresetRule[] = [];
let loadedFixedRule: PresetRule = defaultFixedRule;

export function loadPresets(): PresetsConfig {
  try {
    if (fs.existsSync(config.presetsFile)) {
      const data = fs.readFileSync(config.presetsFile, 'utf-8');
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.rules)) {
          loadedRules = obj.rules as PresetRule[];
        }
        if (obj.fixedRule && typeof obj.fixedRule === 'object') {
          loadedFixedRule = obj.fixedRule as PresetRule;
        }
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Presets] Failed to load presets file: ${message}, using defaults.`);
  }

  return {
    rules: loadedRules,
    fixedRule: loadedFixedRule,
  };
}

export function matchPreset(text: string, hasTools: boolean = false): PresetRule | null {
  if (loadedRules.length === 0) {
    loadPresets();
  }

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  for (const rule of loadedRules) {
    // If rule requires toolCall, but the request doesn't provide tools, we can still match if text matches,
    // or adapt the response (if it has text fallback).
    for (const pattern of rule.patterns) {
      if (rule.isRegex) {
        try {
          const re = new RegExp(pattern, 'i');
          if (re.test(trimmed)) {
            return rule;
          }
        } catch {
          // ignore bad regex
        }
      } else {
        if (lower.includes(pattern.toLowerCase())) {
          return rule;
        }
      }
    }
  }

  return null;
}

export function getFixedRule(): PresetRule {
  if (loadedRules.length === 0) {
    loadPresets();
  }
  return loadedFixedRule;
}
