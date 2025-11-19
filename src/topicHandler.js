/**
 * Forum Topic 相关操作
 * - 创建 Topic
 * - 在 Topic 与私聊之间转发消息
 */

import dayjs from 'dayjs';
import { callTelegramApi } from './core.js';
import { isTopicBanned } from './banManager.js';
import { isSupergroupAdmin } from './messageHandler.js';
import { notifyMessageFailed, notifyMessageSent } from './deliveryStatus.js';
import {
  addMessageMapping,
  cleanupTopicMessages,
  findPmMessageId,
  findTopicMessageId,
  markBan,
  removeMapping,
  upsertMapping,
  updateMapping
} from './metadataManager.js';

const SERVICE_MESSAGE_FIELDS = [
  'forum_topic_created',
  'forum_topic_edited',
  'forum_topic_closed',
  'forum_topic_reopened',
  'general_forum_topic_hidden',
  'general_forum_topic_unhidden',
  'new_chat_members',
  'left_chat_member',
  'pinned_message',
  'delete_chat_photo',
  'group_chat_created',
  'supergroup_chat_created',
  'channel_chat_created'
];

export function isServiceMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return SERVICE_MESSAGE_FIELDS.some((field) => field in message);
}

// 为 Topic 生成可读名称，避免超过上限
function buildTopicName(message, fallbackId) {
  const from = message.chat;
  const fromUserId = message.from?.id;
  const baseId = from.id || fallbackId;
  const username = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ');
  const display = username || 'Guest';
  const suffix = fromUserId && fromUserId !== baseId ? `(${baseId})(${fromUserId})` : `(${baseId})`;
  const name = `${display}`.substring(0, 80);
  return `${name} ${suffix}`.substring(0, 120);
}

// 当映射缺失时，生成引用摘要，避免上下文丢失
function buildReplySummary(replyMessage) {
  const timeStr = replyMessage?.date ? formatHumanTime(replyMessage.date) : '未知时间';
  const preview = (replyMessage?.text || replyMessage?.caption || '[非文本消息]').slice(0, 160);
  return `🧾 引用定位失败\n时间：${timeStr}\n内容：${preview}`;
}

export async function ensureTopic(botToken, metaData, metaMessage, fromChatId, message, ownerUid) {
  const safeCall = (method, body, context) => callTelegramApi(botToken, method, body, { ownerUid, context });

  // 已存在直接返回
  const topicId = metaData.fromChatToTopic.get(fromChatId);
  if (topicId) return { topicId, metaMessage };

  // 检查是否是 Supergroup 管理员
  const isAdmin = await isSupergroupAdmin(botToken, metaData.superGroupChatId, fromChatId);
  if (isAdmin) {
    throw new Error('Cannot create topic for Supergroup admin');
  }

  const superGroupChatId = metaData.superGroupChatId;
  const topicName = buildTopicName(message, fromChatId);
  const createResp = await safeCall('createForumTopic', {
    chat_id: superGroupChatId,
    name: topicName
  }, '创建 Topic');

  const newTopicId = createResp.result?.message_thread_id;
  if (!createResp.ok || !newTopicId) {
    await safeCall('sendMessage', {
      chat_id: ownerUid,
      text: `创建 Topic 失败: ${JSON.stringify(createResp)}`
    }, '创建 Topic 错误通知');
    throw new Error('createForumTopic failed');
  }

  upsertMapping(metaData, newTopicId, fromChatId);
  const updated = await updateMapping(botToken, ownerUid, metaMessage, metaData);
  return { topicId: newTopicId, metaMessage: updated };
}

export async function forwardPrivateToTopic(botToken, ownerUid, metaData, metaMessage, message) {
  const safeCall = (method, body, context) => callTelegramApi(botToken, method, body, { ownerUid, context });
  const fromChatId = message.chat.id;
  const existingTopicId = metaData.fromChatToTopic.get(fromChatId);
  const banned = existingTopicId && isTopicBanned(metaData, existingTopicId);
  if (banned) {
    await safeCall('sendMessage', {
      chat_id: fromChatId,
      text: '你已被禁止发送消息到此论坛话题。'
    }, '私聊被禁提示');
    return new Response('OK');
  }

  try {
    const { topicId, metaMessage: newMetaMessage } = await ensureTopic(botToken, metaData, metaMessage, fromChatId, message, ownerUid);
    let targetTopicId = topicId;

    // 处理引用转发：尽量在群内关联上原消息
    let replyParameters = null;
    if (message.reply_to_message) {
      const { topicId: mappingTopicId, topicMessageId } = await findTopicMessageId(
        botToken,
        metaData.superGroupChatId,
        message.reply_to_message.message_id
      );
      if (mappingTopicId) {
        targetTopicId = mappingTopicId;
      }
      if (topicMessageId) {
        replyParameters = {
          message_id: topicMessageId,
          allow_sending_without_reply: true
        };
      }
      // 找不到映射时，直���忽略引用关系，正常转发消息
    }

    // 使用 copyMessage 便于携带 reply_parameters，保留原消息格式
    const copyBody = {
      chat_id: metaData.superGroupChatId,
      from_chat_id: fromChatId,
      message_id: message.message_id,
      message_thread_id: targetTopicId
    };
    if (replyParameters) copyBody.reply_parameters = replyParameters;

    const resp = await safeCall('copyMessage', copyBody, '私聊转 Topic');

    if (!resp.ok) {
      // 如果 Topic 失效尝试清理映射并重试一次
      if (resp.description?.includes('message thread not found') || resp.description?.includes('TOPIC_ID_INVALID')) {
        removeMapping(metaData, targetTopicId);
        // 清理该 Topic 的所有消息映射
        await cleanupTopicMessages(metaData.superGroupChatId, targetTopicId);
        const refreshed = await updateMapping(botToken, ownerUid, newMetaMessage, metaData);
        return forwardPrivateToTopic(botToken, ownerUid, metaData, refreshed, message);
      }
      await notifyMessageFailed(botToken, fromChatId, message.message_id);
      return new Response('OK');
    }

    const topicMessageId = resp.result?.message_id;
    if (topicMessageId) {
      await addMessageMapping(botToken, metaData.superGroupChatId, targetTopicId, topicMessageId, message.message_id);
    }
    await notifyMessageSent(botToken, fromChatId, message.message_id);
    return new Response('OK');
  } catch (err) {
    console.error('forwardPrivateToTopic error', err);
    await safeCall('sendMessage', {
      chat_id: ownerUid,
      text: `转发私聊消息失败：${err.message || err}`
    }, '私聊转发异常');
    await notifyMessageFailed(botToken, fromChatId, message.message_id);
    return new Response('OK');
  }
}

export async function forwardTopicToPrivate(botToken, ownerUid, metaData, metaMessage, message) {
  const safeCall = (method, body, context) => callTelegramApi(botToken, method, body, { ownerUid, context });
  const topicId = message.message_thread_id;
  const targetChatId = metaData.topicToFromChat.get(topicId);
  if (!targetChatId) return new Response('OK');

  try {
    let replyParameters = null;
    if (message.reply_to_message) {
      const { pmMessageId } = await findPmMessageId(botToken, metaData.superGroupChatId, message.reply_to_message.message_id);
      if (pmMessageId) {
        // 只在找到映射时才设置回复参数
        replyParameters = {
          message_id: pmMessageId,
          allow_sending_without_reply: true
        };
      }
      // 找不到映射时，直接忽略引用关系，正常转发消息
    }

    const copyBody = {
      chat_id: targetChatId,
      from_chat_id: message.chat.id,
      message_id: message.message_id
    };
    if (replyParameters) copyBody.reply_parameters = replyParameters;

    const resp = await safeCall('copyMessage', copyBody, 'Topic 转私聊');
    if (!resp.ok) {
      if (resp.description?.includes('TOPIC_ID_INVALID')) {
        removeMapping(metaData, topicId);
        // 清理该 Topic 的所有消息映射
        await cleanupTopicMessages(metaData.superGroupChatId, topicId);
        await updateMapping(botToken, ownerUid, metaMessage, metaData);
      }
      await notifyMessageFailed(botToken, message.chat.id, message.message_id);
      return new Response('OK');
    }

    const pmMessageId = resp.result?.message_id;
    if (pmMessageId) {
      await addMessageMapping(botToken, metaData.superGroupChatId, topicId, message.message_id, pmMessageId);
    }
    await notifyMessageSent(botToken, message.chat.id, message.message_id);
    return new Response('OK');
  } catch (err) {
    console.error('forwardTopicToPrivate error', err);
    await safeCall('sendMessage', {
      chat_id: ownerUid,
      text: `向私聊复制失败：${err.message || err}`
    }, 'Topic 转发异常');
    await notifyMessageFailed(botToken, message.chat.id, message.message_id);
    return new Response('OK');
  }
}

export async function changeBanStatus(botToken, ownerUid, metaData, metaMessage, topicId, banned) {
  const safeCall = (method, body, context) => callTelegramApi(botToken, method, body, { ownerUid, context });
  const alreadyBanned = isTopicBanned(metaData, topicId);
  if (alreadyBanned === banned) {
    const text = banned ? '此话题已在拉黑列表中。' : '此话题当前未被拉黑。';
    await safeCall('sendMessage', {
      chat_id: metaData.superGroupChatId,
      message_thread_id: topicId,
      text
    }, '重复拉黑提示');
    return new Response('OK');
  }

  if (!metaData.topicToFromChat.has(topicId)) {
    await safeCall('sendMessage', {
      chat_id: metaData.superGroupChatId,
      message_thread_id: topicId,
      text: '未找到该话题的私聊映射，无法更新拉黑状态。'
    }, '无映射提示');
    return new Response('OK');
  }

  markBan(metaData, topicId, banned);
  await updateMapping(botToken, ownerUid, metaMessage, metaData);
  const text = banned ? '本话题已被禁止私聊消息进入' : '本话题已解除禁止';
  await safeCall('sendMessage', {
    chat_id: metaData.superGroupChatId,
    message_thread_id: topicId,
    text
  }, '变更拉黑状态');
  return new Response('OK');
}

export function formatHumanTime(ts) {
  return dayjs.unix(ts).format('YYYY-MM-DD HH:mm:ss');
}
