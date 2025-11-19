/**
 * Fivegram - 核心路由
 * 兼容 Cloudflare Workers 与 Vercel，无状态处理 HTTP 路由
 */

import { handleUpdate } from './messageHandler.js';

export const allowedUpdates = ['message', 'message_reaction', 'edited_message'];

export function validateSecretToken(token) {
  return token && token.length >= 16 && /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function postToTelegramApi(token, method, body) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

/**
 * 包装后的 API 调用，统一捕获错误并向 owner 上报
 * @param {string} token - Bot Token
 * @param {string} method - Telegram Bot API 方法
 * @param {object} body - 请求体
 * @param {object} options - 扩展配置
 * @param {string|number} options.ownerUid - 机器人所有者，用于推送错误日志
 * @param {string} options.context - 便于排查的场景描述
 */
export async function callTelegramApi(token, method, body, options = {}) {
  const { ownerUid, context } = options;
  try {
    const resp = await postToTelegramApi(token, method, body);
    const data = await resp.json();

    // 将非 sendMessage 的异常上报 owner，避免循环递归
    if (!data.ok && ownerUid && method !== 'sendMessage') {
      try {
        await postToTelegramApi(token, 'sendMessage', {
          chat_id: ownerUid,
          text: `⚠️ 接口 ${method} 调用失败${context ? `（${context}）` : ''}：${data.description || 'Unknown error'}`
        });
      } catch (notifyErr) {
        console.error('上报错误失败', notifyErr);
      }
    }
    return data;
  } catch (err) {
    console.error(`callTelegramApi ${method} error`, err);
    if (ownerUid && method !== 'sendMessage') {
      try {
        await postToTelegramApi(token, 'sendMessage', {
          chat_id: ownerUid,
          text: `❌ 接口 ${method} 调用异常${context ? `（${context}）` : ''}: ${err.message || err}`
        });
      } catch (notifyErr) {
        console.error('上报异常失败', notifyErr);
      }
    }
    return { ok: false, description: err.message || String(err) };
  }
}

async function handleInstall(request, ownerUid, botToken, prefix, secretToken) {
  if (!validateSecretToken(secretToken)) {
    return jsonResponse({
      success: false,
      message: 'Secret token 至少 16 位并包含大小写字母与数字'
    }, 400);
  }

  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.hostname}`;
  const webhookUrl = `${baseUrl}/${prefix}/webhook/${ownerUid}/${botToken}`;

  const resp = await callTelegramApi(botToken, 'setWebhook', {
    url: webhookUrl,
    allowed_updates: allowedUpdates,
    secret_token: secretToken
  }, { ownerUid, context: '安装 Webhook' });
  if (resp.ok) return jsonResponse({ success: true, message: 'Webhook installed' });
  return jsonResponse({ success: false, message: resp.description || 'Failed to install' }, 400);
}

async function handleUninstall(botToken, secretToken) {
  if (!validateSecretToken(secretToken)) {
    return jsonResponse({
      success: false,
      message: 'Secret token 至少 16 位并包含大小写字母与数字'
    }, 400);
  }

  const resp = await callTelegramApi(botToken, 'deleteWebhook', {}, { context: '删除 Webhook' });
  if (resp.ok) return jsonResponse({ success: true, message: 'Webhook removed' });
  return jsonResponse({ success: false, message: resp.description || 'Failed to uninstall' }, 400);
}

async function handleWebhook(request, ownerUid, botToken, secretToken, messageMapping, ctx) {
  if (secretToken && secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
    return new Response('Unauthorized', { status: 401 });
  }
  const update = await request.json();
  return handleUpdate(update, { ownerUid, botToken, secretToken, messageMapping }, ctx);
}

export async function handleRequest(request, config, ctx) {
  const { prefix, secretToken, messageMapping } = config;
  const url = new URL(request.url);
  const path = url.pathname;

  const INSTALL_PATTERN = new RegExp(`^/${prefix}/install/([^/]+)/([^/]+)$`);
  const UNINSTALL_PATTERN = new RegExp(`^/${prefix}/uninstall/([^/]+)$`);
  const WEBHOOK_PATTERN = new RegExp(`^/${prefix}/webhook/([^/]+)/([^/]+)$`);

  let match;
  if ((match = path.match(INSTALL_PATTERN))) {
    return handleInstall(request, match[1], match[2], prefix, secretToken);
  }
  if ((match = path.match(UNINSTALL_PATTERN))) {
    return handleUninstall(match[1], secretToken);
  }
  if ((match = path.match(WEBHOOK_PATTERN))) {
    return handleWebhook(request, match[1], match[2], secretToken, messageMapping, ctx);
  }

  return new Response('Not Found', { status: 404 });
}
