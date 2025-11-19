/**
 * 拉黑 / 解除拉黑逻辑
 * - 通过修改元数据中的 chatId 前缀 (b) 标记话题是否被单向拉黑
 */

import { callTelegramApi } from './core.js';
import { markBan, updateMapping } from './metadataManager.js';

/**
 * 检查 Topic 是否被拉黑
 */
export function isTopicBanned(metaData, topicId) {
  if (!metaData?.bannedTopics) return false;
  return metaData.bannedTopics.includes(topicId.toString());
}

async function notifyTopic(botToken, chatId, topicId, text) {
  await callTelegramApi(botToken, 'sendMessage', {
    chat_id: chatId,
    message_thread_id: topicId,
    text
  });
}

/**
 * 拉黑指定 Topic（单向：用户发送的消息不转发，owner 仍可发送）
 */
export async function banTopic(botToken, ownerUid, message, metaData, metaMessage, isSilent = false) {
  const api = (method, body, context) => callTelegramApi(botToken, method, body, { ownerUid, context });
  const topicId = message?.message_thread_id;
  const superGroupChatId = message?.chat?.id;
  if (!topicId || !superGroupChatId) {
    await api('sendMessage', {
      chat_id: ownerUid,
      text: '无法获取 Topic 信息，请在话题内使用拉黑命令。'
    });
    return new Response('OK');
  }

  // 未建立映射时提前告知，避免写入无效数据
  const fromChatId = metaData.topicToFromChat.get(topicId);
  if (!fromChatId) {
    await notifyTopic(botToken, superGroupChatId, topicId, '未找到该话题对应的私聊映射，拉黑操作已取消。');
    return new Response('OK');
  }

  if (isTopicBanned(metaData, topicId)) {
    await notifyTopic(botToken, superGroupChatId, topicId, '该话题已在拉黑列表，无需重复操作。');
    return new Response('OK');
  }

  try {
    // 在元数据中标记拉黑：chatId 前缀加上 b
    markBan(metaData, topicId, true);
    await updateMapping(botToken, ownerUid, metaMessage, metaData);
    await notifyTopic(botToken, superGroupChatId, topicId, '已拉黑此话题，来自私聊的消息将不再转发。');

    if (!isSilent) {
      await api('sendMessage', {
        chat_id: fromChatId,
        text: '你已被拉黑，发送的消息不会再被转发到群组。'
      });
    }
  } catch (err) {
    await notifyTopic(botToken, superGroupChatId, topicId, `拉黑失败：${err.message || err}`);
  }

  return new Response('OK');
}

/**
 * 解除拉黑
 */
export async function unbanTopic(botToken, ownerUid, message, metaData, metaMessage, isSilent = false) {
  const api = (method, body, context) => callTelegramApi(botToken, method, body, { ownerUid, context });
  const topicId = message?.message_thread_id;
  const superGroupChatId = message?.chat?.id;
  if (!topicId || !superGroupChatId) {
    await api('sendMessage', {
      chat_id: ownerUid,
      text: '无法获取 Topic 信息，请在话题内使用解除拉黑命令。'
    });
    return new Response('OK');
  }

  const fromChatId = metaData.topicToFromChat.get(topicId);
  if (!isTopicBanned(metaData, topicId)) {
    await notifyTopic(botToken, superGroupChatId, topicId, '该话题当前未被拉黑。');
    return new Response('OK');
  }

  try {
    // 移除前缀 b，恢复正常转发
    markBan(metaData, topicId, false);
    await updateMapping(botToken, ownerUid, metaMessage, metaData);
    await notifyTopic(botToken, superGroupChatId, topicId, '已解除拉黑，私聊消息可以再次转发到话题。');

    if (!isSilent && fromChatId) {
      await api('sendMessage', {
        chat_id: fromChatId,
        text: '你已被解除拉黑，可以继续发送消息。'
      });
    }
  } catch (err) {
    await notifyTopic(botToken, superGroupChatId, topicId, `解除拉黑失败：${err.message || err}`);
  }

  return new Response('OK');
}
