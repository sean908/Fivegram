/**
 * Emoji Reaction 同步处理
 * - 支持私聊与超级群 Topic 之间的表情双向同步
 * - 使用超级群置顶消息记录消息 ID 映射关系
 */

import { isTopicBanned } from './banManager.js';
import { callTelegramApi } from './core.js';
import { findPmMessageId, findTopicMessageId } from './metadataManager.js';

/**
 * 处理 message_reaction update
 * @param {string} botToken
 * @param {number} ownerUid
 * @param {object} messageReaction - update.message_reaction
 * @param {object} metaData - 解析后的元数据
 */
export async function processMessageReaction(botToken, ownerUid, messageReaction, metaData) {
  const fromChat = messageReaction.chat;
  const fromUser = messageReaction.user;

  // 判断是 owner 还是用户的 reaction
  if (fromUser.id === ownerUid && fromChat.id === metaData.superGroupChatId && fromChat.is_forum) {
    // Owner 在 supergroup 点击 emoji → 转发给用户
    await processOwnerReaction(botToken, messageReaction, metaData);
  } else {
    // 用户点击 emoji → 转发到 topic
    const topicId = metaData.fromChatToTopic.get(fromChat.id);
    if (!topicId) return; // 用户未初始化
    if (isTopicBanned(metaData, topicId)) return; // 被 ban 的不转发

    await processUserReaction(botToken, ownerUid, messageReaction, metaData);
  }
}

async function processUserReaction(botToken, ownerUid, messageReaction, metaData) {
  const pmMessageId = messageReaction.message_id;
  const { topicId, topicMessageId } = await findTopicMessageId(botToken, metaData.superGroupChatId, pmMessageId);
  if (!topicMessageId || !topicId) return;

  // 同步用户侧的 reaction 到超级群对应话题消息
  await setMessageReaction(botToken, metaData.superGroupChatId, topicMessageId, messageReaction.new_reaction || []);
}

async function processOwnerReaction(botToken, messageReaction, metaData) {
  const topicId = messageReaction.message_thread_id;
  if (!topicId) return;

  const targetChatId = metaData.topicToFromChat.get(topicId);
  if (!targetChatId) return;

  const { pmMessageId } = await findPmMessageId(botToken, metaData.superGroupChatId, messageReaction.message_id);
  if (!pmMessageId) return;

  // 同步 Owner 在话题中的 reaction 到用户私聊
  await setMessageReaction(botToken, targetChatId, pmMessageId, messageReaction.new_reaction || []);
}

/**
 * 设置消息的 emoji reaction
 * - 处理 REACTIONS_TOO_MANY：降级为最后一个 emoji
 * - 处理 REACTION_INVALID：通常是 Premium 表情，不做重试
 */
export async function setMessageReaction(botToken, chatId, messageId, reaction) {
  const safeCall = (method, body, context) => callTelegramApi(botToken, method, body, { context });
  const reactionList = Array.isArray(reaction) ? reaction : [];
  const resp = await safeCall('setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: reactionList
  }, '设置 Reaction');

  if (resp.ok) return resp;

  const description = resp.description || '';
  if (description.includes('REACTIONS_TOO_MANY')) {
    // Bot 只能设置 1 个表情，退化为最后一个
    const fallbackReaction = reactionList.length > 0 ? reactionList.slice(-1) : [];
    return (await safeCall('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: fallbackReaction
    }, '降级 Reaction'));
  }

  if (description.includes('REACTION_INVALID')) {
    // Premium Emoji 无法使用，日志后跳过
    console.warn('setMessageReaction skipped due to REACTION_INVALID', resp);
    return resp;
  }

  console.error('setMessageReaction failed', resp);
  return resp;
}
