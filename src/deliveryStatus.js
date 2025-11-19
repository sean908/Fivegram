/**
 * 消息投递状态提醒
 * - 通过表情 Reaction 反馈发送、编辑、删除、失败等状态
 */

import { setMessageReaction } from './reactionHandler.js';

/**
 * 发送成功后显示 🕊 表情
 */
export async function notifyMessageSent(botToken, chatId, messageId) {
  await setMessageReaction(botToken, chatId, messageId, [{ type: 'emoji', emoji: '🕊' }]);
}

/**
 * 编辑成功后显示 🦄 表情 1 秒后恢复 🕊
 */
export async function notifyMessageEdited(botToken, chatId, messageId) {
  await setMessageReaction(botToken, chatId, messageId, [{ type: 'emoji', emoji: '🦄' }]);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await setMessageReaction(botToken, chatId, messageId, [{ type: 'emoji', emoji: '🕊' }]);
}

/**
 * 删除成功后显示 🗿 表情
 */
export async function notifyMessageDeleted(botToken, chatId, messageId) {
  await setMessageReaction(botToken, chatId, messageId, [{ type: 'emoji', emoji: '🗿' }]);
}

/**
 * 转发失败显示 ❌ 表情
 */
export async function notifyMessageFailed(botToken, chatId, messageId) {
  await setMessageReaction(botToken, chatId, messageId, [{ type: 'emoji', emoji: '❌' }]);
}
