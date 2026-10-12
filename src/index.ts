import { createApp } from './app.js';
import { config } from './config.js';
import { loadPresets } from './presets.js';

const app = createApp();

// Pre-load presets
const presets = loadPresets();
console.log(`[Gateway] Loaded ${presets.rules.length} preset rules from ${config.presetsFile}`);
console.log(`[Gateway] Supported models: ${config.models.join(', ')}`);
console.log(`[Gateway] Upstream default model: ${config.defaultModel}`);
console.log(`[Gateway] Anti-probe settings: 1st turn match preset, turns 2..${config.maxForwardCount} real forward, turn >${config.maxForwardCount} fixed response.`);

const server = app.listen(config.port, () => {
  console.log(`[Gateway] Fake LLM Gateway listening on port ${config.port}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    console.log('[Gateway] Server closed.');
    process.exit(0);
  });
});
