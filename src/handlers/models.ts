import { Request, Response } from 'express';
import { config } from '../config.js';

export function handleGetModels(_req: Request, res: Response): void {
  const modelList = config.models.map((id) => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'system',
    permission: [],
    root: id,
    parent: null,
  }));

  res.json({
    object: 'list',
    data: modelList,
  });
}
