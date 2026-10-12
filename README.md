# Fake LLM API Gateway

A deceptive, high-fidelity mock and proxy gateway for LLM APIs built with Node.js and TypeScript. Designed to withstand anti-probing and capability benchmark evaluation suites (e.g., SVG generation, complex reasoning, token-rate analysis).

## Features

- **Multi-Protocol Support**:
  - OpenAI Chat Completions (`/v1/chat/completions`) — JSON & Streaming SSE
  - OpenAI Responses API (`/v1/responses`) — Multi-output & Streaming SSE
  - Anthropic Messages API (`/v1/messages`) — Thinking blocks, tools, & Streaming SSE
  - Models Discovery (`/v1/models`)
- **Anti-Anti-Probing State Machine**:
  - **Turn 1**: Probe intent detection. If matched, returns high-fidelity simulated response with CoT, tools, realistic headers, and cache metrics. If unmatched, performs authentic forward to upstream.
  - **Turns 2 ~ N**: Authentic forwarding to upstream model (`MODEL`).
  - **Turns > N**: Canned fixed response to prevent quota exhaustion.
- **Decision Engine (TypeSafe Jev + Regex Fallback)**:
  - Default: System One decision routing via `typesafe/jev-1.13` (OpenRouter Decisions API) to semantically detect probe prompts across paraphrased variants.
  - Fallback: Local regex & substring matching when Jev is offline or times out.
- **Pre-set Benchmark Defenses**:
  - Classic Pelican on Bicycle SVG (`Generate an SVG of a pelican riding a bicycle.`)
  - Pigeonhole Candy Drawer Math Problem (3 flavors, 2 shapes, worst-case deduction)
  - Enhanced Goose Wing Composite Benchmark (Goose riding bicycle on plane wing, Sun Wukong cockpit, Qin Shi Huang tightening screws on polar bear, shouting candy result)
  - Latency / Connectivity Probes (`ping`, `hi`, `response ok`, `strawberry`)
- **Realistic Gateway Metrics & Pacing**:
  - **TPS Stabilization**: Drift-compensated token pacing (default 45 tokens/s with natural ±8% jitter).
  - **Prompt Cache Simulation**: Emulates `cached_tokens` / `cache_read_input_tokens` (2,560 ~ 6,144 tokens).
  - **Reasoning Tokens**: Emulates `reasoning_tokens` (20 ~ 950 tokens).
  - **Gateway Headers**: `x-request-id`, `openai-processing-ms`, `cf-ray`, `anthropic-ratelimit-*`.
- **Auditing & Logging**:
  - Full request logs tracking client IP, requested model, turn #, matched rules, tokens, latency, and status in `logs/gateway.log`.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

### 3. Build & Run

```bash
# Build TypeScript
npm run build

# Start Gateway
npm start

# Or run in development mode with hot-reload
npm run dev
```

### 4. Run Tests

```bash
# Full test suite (14 end-to-end tests)
npm test

# Live TPS stream measurement test
npx tsx test/test_tps.ts
```

### 5. Docker Deployment

Pull and run the prebuilt multi-arch image from GitHub Container Registry:

```bash
docker run -d \
  --name fakeapi-gateway \
  -p 3000:3000 \
  --env-file .env \
  --restart always \
  ghcr.io/huochai67/fakeapi:latest
```

Or build locally:

```bash
docker build -t fakeapi .
docker run -d -p 3000:3000 --env-file .env fakeapi
```

## Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Gateway listening port | `3000` |
| `MODELS` | Comma-separated list of advertised models | `gpt5.6-sol,gpt6.1-sol,gpt6-astra` |
| `MODEL` | Default upstream forwarding model | `inclusionai/ling-3.1-flash` |
| `OPENAI_BASEURL` | Upstream OpenAI endpoint | `https://openrouter.ai/api/v1` |
| `OPENAI_APIKEY` | Upstream OpenAI/OpenRouter API key | - |
| `ANTHROPIC_BASE_URL` | Upstream Anthropic endpoint | `https://openrouter.ai/api/v1` |
| `ANTHROPIC_APIKEY` | Upstream Anthropic API key | - |
| `MAX_FORWARD_COUNT` | Number of requests forwarded before fixed response | `3` |
| `ENABLE_JEV` | Enable TypeSafe Jev decision classifier | `true` |
| `JEV_TIMEOUT_MS` | Jev decision timeout in milliseconds | `2500` |
| `TARGET_TPS` | Output streaming token rate (tokens/sec) | `45` |
| `TPS_JITTER` | Natural token-rate jitter ratio (e.g. 0.08 = ±8%) | `0.08` |
