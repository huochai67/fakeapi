import { Request } from 'express';
import { ClientState, GatewayAction, PresetRule } from './types.js';
import { config } from './config.js';
import { matchPreset, loadPresets } from './presets.js';
import { matchPresetWithJev } from './jevRouter.js';

class StateStore {
  private clients = new Map<string, ClientState>();

  getClientIp(req: Request): string {
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string') {
      const first = xForwardedFor.split(',')[0]?.trim();
      if (first) return first;
    }
    const xRealIp = req.headers['x-real-ip'];
    if (typeof xRealIp === 'string' && xRealIp.trim()) {
      return xRealIp.trim();
    }
    const remote = req.socket?.remoteAddress;
    if (remote) {
      // normalize IPv6 ::ffff:127.0.0.1 to 127.0.0.1
      return remote.replace(/^::ffff:/, '');
    }
    return '127.0.0.1';
  }

  async evaluateRequest(ip: string, promptText: string, hasTools: boolean): Promise<{
    turn: number;
    action: GatewayAction;
    matchedRule?: PresetRule;
  }> {
    const now = Date.now();
    let state = this.clients.get(ip);
    if (!state) {
      state = {
        ip,
        requestCount: 0,
        firstRequestTime: now,
        lastRequestTime: now,
        history: [],
      };
      this.clients.set(ip, state);
    }

    state.requestCount += 1;
    state.lastRequestTime = now;
    const turn = state.requestCount;

    if (turn === 1) {
      let matched: PresetRule | null = null;
      let source = 'none';

      if (config.enableJev) {
        const jevResult = await matchPresetWithJev(promptText);
        if (jevResult.available && jevResult.rule) {
          matched = jevResult.rule;
          source = 'jev';
        } else if (!jevResult.available) {
          // Jev 不可用（超时、网络异常、报错），关键词兜底
          matched = matchPreset(promptText, hasTools);
          if (matched) source = 'keyword_fallback';
        } else {
          // Jev 可用但未分类为 probe，兜底检查强关键词以防漏判
          matched = matchPreset(promptText, hasTools);
          if (matched) source = 'keyword_safety_net';
        }
      } else {
        matched = matchPreset(promptText, hasTools);
        if (matched) source = 'keyword';
      }

      if (matched) {
        state.history.push({
          timestamp: now,
          endpoint: '',
          model: '',
          hitRule: `${matched.name} (${source})`,
          action: 'preset_hit',
        });
        return {
          turn,
          action: { type: 'preset', rule: matched },
          matchedRule: matched,
        };
      }
      // First turn but probe didn't match: real forward to upstream
      state.history.push({
        timestamp: now,
        endpoint: '',
        model: '',
        action: 'real_forward',
      });
      return {
        turn,
        action: { type: 'forward', targetModel: config.defaultModel },
      };
    }

    if (turn <= config.maxForwardCount) {
      // Turn 2 to N: real forward
      state.history.push({
        timestamp: now,
        endpoint: '',
        model: '',
        action: 'real_forward',
      });
      return {
        turn,
        action: { type: 'forward', targetModel: config.defaultModel },
      };
    }

    // Turn > N: fixed response
    const presets = loadPresets();
    state.history.push({
      timestamp: now,
      endpoint: '',
      model: '',
      action: 'fixed_canned',
    });
    return {
      turn,
      action: { type: 'fixed', rule: presets.fixedRule },
      matchedRule: presets.fixedRule,
    };
  }

  reset(ip?: string): void {
    if (ip) {
      this.clients.delete(ip);
    } else {
      this.clients.clear();
    }
  }

  getState(ip: string): ClientState | undefined {
    return this.clients.get(ip);
  }
}

export const stateStore = new StateStore();
