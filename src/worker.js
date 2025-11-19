/**
 * Fivegram - Cloudflare Worker 入口
 * 负责解析请求并委托给核心逻辑
 */

import { handleRequest } from './core.js';

export default {
  async fetch(request, env, ctx) {
    const config = {
      prefix: env.PREFIX || 'fivegram',
      secretToken: env.SECRET_TOKEN || '',
      messageMapping: env.MESSAGE_MAPPING,  // KV namespace 绑定
    };

    return handleRequest(request, config, ctx);
  }
};
