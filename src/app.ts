import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { handleOpenAIChat } from './handlers/openaiChat.js';
import { handleOpenAIResponses } from './handlers/openaiResponses.js';
import { handleAnthropicMessages } from './handlers/anthropicMessages.js';
import { handleGetModels } from './handlers/models.js';
import { stateStore } from './state.js';
import { loadPresets } from './presets.js';

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Root / Health
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'Fake LLM API Gateway',
      time: new Date().toISOString(),
    });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy' });
  });

  // Models listing
  app.get('/v1/models', handleGetModels);
  app.get('/models', handleGetModels);

  // OpenAI Chat Completions
  app.post('/v1/chat/completions', (req: Request, res: Response, next: NextFunction) => {
    handleOpenAIChat(req, res).catch(next);
  });
  app.post('/chat/completions', (req: Request, res: Response, next: NextFunction) => {
    handleOpenAIChat(req, res).catch(next);
  });

  // Legacy completions adapter (if caller uses /v1/completions)
  app.post('/v1/completions', (req: Request, res: Response, next: NextFunction) => {
    if (typeof req.body?.prompt === 'string' && !req.body.messages) {
      req.body.messages = [{ role: 'user', content: req.body.prompt }];
    }
    handleOpenAIChat(req, res).catch(next);
  });

  // OpenAI Responses API
  app.post('/v1/responses', (req: Request, res: Response, next: NextFunction) => {
    handleOpenAIResponses(req, res).catch(next);
  });
  app.post('/responses', (req: Request, res: Response, next: NextFunction) => {
    handleOpenAIResponses(req, res).catch(next);
  });

  // Anthropic Messages API
  app.post('/v1/messages', (req: Request, res: Response, next: NextFunction) => {
    handleAnthropicMessages(req, res).catch(next);
  });
  app.post('/messages', (req: Request, res: Response, next: NextFunction) => {
    handleAnthropicMessages(req, res).catch(next);
  });

  // Internal debug / test endpoints
  app.post('/_internal/reset', (req: Request, res: Response) => {
    const ip = typeof req.body?.ip === 'string' ? req.body.ip : undefined;
    stateStore.reset(ip);
    res.json({ ok: true, reset: ip || 'all' });
  });

  app.get('/_internal/state', (req: Request, res: Response) => {
    const ip = typeof req.query?.ip === 'string' ? req.query.ip : stateStore.getClientIp(req);
    const state = stateStore.getState(ip);
    res.json({ ip, state: state || null });
  });

  app.get('/_internal/presets', (_req: Request, res: Response) => {
    const presets = loadPresets();
    res.json(presets);
  });

  // Error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[App] Unhandled error:', message);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: 'Internal Gateway Error',
          details: message,
        },
      });
    }
  });

  return app;
}
