export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  tools?: Record<string, unknown>[];
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface OpenAIResponseItem {
  id?: string;
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  status?: string;
  [key: string]: unknown;
}

export interface OpenAIResponsesRequest {
  model: string;
  input: string | Record<string, unknown>[];
  stream?: boolean;
  instructions?: string;
  tools?: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface AnthropicContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  tool_use_id?: string;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  stream?: boolean;
  tools?: Record<string, unknown>[];
  max_tokens?: number;
  [key: string]: unknown;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  reasoning_tokens?: number;
}

export interface PresetRule {
  id: string;
  name: string;
  // Patterns to match in user prompt (case-insensitive)
  patterns: string[];
  isRegex?: boolean;
  // If request contains tools and prompt matches, should it prioritize tool call?
  hasToolCall?: boolean;
  // Does it contain Chain of Thought?
  hasCot?: boolean;
  // Normalized responses for each protocol
  response: {
    text: string;
    thinking?: string;
    thinkingSignature?: string;
    toolCall?: {
      name: string;
      arguments: Record<string, unknown>;
    };
  };
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens: number;
    reasoning_tokens?: number;
  };
}

export interface ClientState {
  ip: string;
  requestCount: number;
  firstRequestTime: number;
  lastRequestTime: number;
  history: Array<{
    timestamp: number;
    endpoint: string;
    model: string;
    hitRule?: string;
    action: 'preset_hit' | 'real_forward' | 'fixed_canned';
  }>;
}

export type GatewayAction =
  | { type: 'preset'; rule: PresetRule }
  | { type: 'forward'; targetModel: string }
  | { type: 'fixed'; rule: PresetRule };
