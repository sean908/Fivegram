/**
 * Pinned Message 元数据管理
 * - 将超管聊天室 ID 及 Topic 映射保存在 Owner 私聊置顶消息中
 * - 格式: `superGroupId;topicId:fromChatId[:comment]`，若被拉黑则 chatId 前缀加 `b`
 *   例如: `-100123;10:123456` 或 `-100123;10:b123456`
 */

import { getKvStore } from './kvConfig.js';
import { callTelegramApi } from './core.js';

const MAX_TEXT_LENGTH = 4096; // Telegram 文本上限，内部进行 FIFO 压缩
const MAX_MESSAGE_MAPPING_LENGTH = 4096; // 超管群置顶消息长度控制，避免超限
const MESSAGE_MAPPING_SEPARATOR = ';';

export function parseMetadataText(text) {
  // 返回空结构，便于后续逻辑安全访问
  if (!text) {
    return {
      superGroupChatId: null,
      topicToFromChat: new Map(),
      fromChatToTopic: new Map(),
      bannedTopics: [],
      topicToComment: new Map(),
      fromChatToComment: new Map()
    };
  }

  const [groupIdRaw, ...pairs] = text.split(';').filter(Boolean);
  const superGroupChatId = groupIdRaw ? parseInt(groupIdRaw, 10) : null;
  const topicToFromChat = new Map();
  const fromChatToTopic = new Map();
  const bannedTopics = [];
  const topicToComment = new Map();
  const fromChatToComment = new Map();

  for (const item of pairs) {
    const segments = item.split(':');
    const topicId = parseInt(segments[0], 10);
    if (Number.isNaN(topicId)) continue;

    let userChunk = segments[1] || '';
    let banned = false;
    if (userChunk.startsWith('b')) {
      // 前缀 b 表示被拉黑
      banned = true;
      userChunk = userChunk.slice(1);
    }
    const fromChatId = parseInt(userChunk, 10);
    if (Number.isNaN(fromChatId)) continue;

    const commentName = segments[2] || '';

    topicToFromChat.set(topicId, fromChatId);
    fromChatToTopic.set(fromChatId, topicId);
    if (banned) bannedTopics.push(topicId.toString());
    if (commentName) {
      topicToComment.set(topicId, commentName);
      fromChatToComment.set(fromChatId, commentName);
    }
  }

  return { superGroupChatId, topicToFromChat, fromChatToTopic, bannedTopics, topicToComment, fromChatToComment };
}

export function parseMetaDataMessage(metaMessage) {
  // 兼容旧逻辑，直接透传 text 进行解析
  return parseMetadataText(metaMessage?.text || '');
}

function stringifyMetadata(superGroupChatId, topicToFromChat, bannedTopics, topicToComment) {
  const entries = [superGroupChatId];
  const bannedSet = new Set((bannedTopics || []).map((id) => id.toString()));
  for (const [topicId, fromChatId] of topicToFromChat.entries()) {
    const banned = bannedSet.has(topicId.toString()) ? 'b' : '';
    const comment = topicToComment.get(topicId);
    const encodedComment = comment ? comment.replace(/[;:]/g, '') : '';
    const item = `${topicId}:${banned}${fromChatId}${encodedComment ? `:${encodedComment}` : ''}`;
    entries.push(item);
  }
  return entries.join(';');
}

// 保证元数据长度不超过 4096，超出时按插入顺序丢弃最早的映射
function trimMetadataEntries(data) {
  let serialized = stringifyMetadata(data.superGroupChatId, data.topicToFromChat, data.bannedTopics, data.topicToComment);
  if (serialized.length <= MAX_TEXT_LENGTH) return serialized;

  const iterator = data.topicToFromChat.keys();
  while (serialized.length > MAX_TEXT_LENGTH && data.topicToFromChat.size > 0) {
    const oldestTopicId = iterator.next().value;
    if (oldestTopicId === undefined) break;
    removeMapping(data, oldestTopicId);
    serialized = stringifyMetadata(data.superGroupChatId, data.topicToFromChat, data.bannedTopics, data.topicToComment);
  }
  return serialized.slice(0, MAX_TEXT_LENGTH);
}

async function editMetadata(botToken, ownerUid, metaMessage, newText) {
  const safeText = newText.slice(0, MAX_TEXT_LENGTH);
  if (safeText.length > MAX_TEXT_LENGTH) {
    throw new Error('Metadata text too long');
  }

  // 不传 ownerUid 以避免 "message is not modified" 错误上报
  const resp = await callTelegramApi(botToken, 'editMessageText', {
    chat_id: ownerUid,
    message_id: metaMessage.message_id,
    text: safeText
  }, { context: '更新元数据' });

  if (!resp.ok) {
    // 忽略 "message is not modified" 错误（内容相同时）
    if (resp.description?.includes('message is not modified')) {
      console.log('Metadata unchanged, skipping update');
      return metaMessage;
    }
    console.error('editMessageText failed', resp);
    return metaMessage;
  }
  return resp.result;
}

export async function ensureMetadata(botToken, ownerUid, superGroupChatId) {
  // 读取置顶消息，如果不存在则创建
  const chatInfo = await callTelegramApi(botToken, 'getChat', { chat_id: ownerUid }, { ownerUid, context: '获取 owner 置顶' });
  const pinned = chatInfo.result?.pinned_message;
  if (pinned?.text) {
    return pinned;
  }

  if (!superGroupChatId) {
    throw new Error('尚未初始化，缺少 superGroupChatId');
  }

  const sendResp = await callTelegramApi(botToken, 'sendMessage', {
    chat_id: ownerUid,
    text: String(superGroupChatId)
  }, { ownerUid, context: '初始化元数据消息' });
  if (!sendResp.ok) {
    throw new Error(`创建元数据消息失败: ${JSON.stringify(sendResp)}`);
  }
  const pinResp = await callTelegramApi(botToken, 'pinChatMessage', {
    chat_id: ownerUid,
    message_id: sendResp.result.message_id
  }, { ownerUid, context: '置顶元数据消息' });
  if (!pinResp.ok) {
    throw new Error(`置顶元数据失败: ${JSON.stringify(pinResp)}`);
  }
  return { ...sendResp.result, chat: { id: ownerUid } };
}

export async function loadMetadata(botToken, ownerUid) {
  const chatInfo = await callTelegramApi(botToken, 'getChat', { chat_id: ownerUid }, { ownerUid, context: '读取元数据' });
  return chatInfo.result?.pinned_message || null;
}

export async function updateMapping(botToken, ownerUid, metaMessage, data) {
  const kvStore = getKvStore();

  // 优先保存到 KV
  if (kvStore && data.superGroupChatId) {
    await saveTopicMappingToKV(kvStore, data.superGroupChatId, data);
  }

  // 同时保存到置顶消息（备份/兼容）
  const newText = trimMetadataEntries(data);
  return editMetadata(botToken, ownerUid, metaMessage, newText);
}

export function upsertMapping(data, topicId, fromChatId, commentName) {
  const { topicToFromChat, fromChatToTopic, topicToComment, fromChatToComment } = data;
  topicToFromChat.set(topicId, fromChatId);
  fromChatToTopic.set(fromChatId, topicId);
  if (commentName) {
    topicToComment.set(topicId, commentName);
    fromChatToComment.set(fromChatId, commentName);
  }
}

export function markBan(data, topicId, banned) {
  const { bannedTopics } = data;
  const topicKey = topicId.toString();
  const idx = bannedTopics.indexOf(topicKey);
  if (banned && idx === -1) bannedTopics.push(topicKey);
  if (!banned && idx !== -1) bannedTopics.splice(idx, 1);
}

export function removeMapping(data, topicId) {
  const { topicToFromChat, fromChatToTopic, topicToComment, fromChatToComment, bannedTopics } = data;
  const fromChatId = topicToFromChat.get(topicId);
  if (fromChatId) {
    fromChatToTopic.delete(fromChatId);
    fromChatToComment.delete(fromChatId);
  }
  topicToFromChat.delete(topicId);
  topicToComment.delete(topicId);
  const bannedKey = topicId.toString();
  const bannedIdx = bannedTopics?.indexOf(bannedKey);
  if (bannedIdx !== undefined && bannedIdx >= 0) {
    bannedTopics.splice(bannedIdx, 1);
  }
}

/**
 * 解析超管群置顶消息中的消息映射数据
 * - 单条格式：topicId-topicMessageId:pmMessageId
 */
function parseMessageMappings(text = '') {
  if (!text) return [];
  const entries = [];
  for (const chunk of text.split(MESSAGE_MAPPING_SEPARATOR)) {
    if (!chunk) continue;
    const [topicMessageChunk, pmMessageIdRaw] = chunk.split(':');
    if (!topicMessageChunk || !pmMessageIdRaw) continue;
    const [topicIdRaw, topicMessageIdRaw] = topicMessageChunk.split('-');
    const topicId = parseInt(topicIdRaw, 10);
    const topicMessageId = parseInt(topicMessageIdRaw, 10);
    const pmMessageId = parseInt(pmMessageIdRaw, 10);
    if (Number.isNaN(topicId) || Number.isNaN(topicMessageId) || Number.isNaN(pmMessageId)) continue;
    entries.push({ topicId, topicMessageId, pmMessageId });
  }
  return entries;
}

/**
 * 读取超管群当前的置顶消息文本（用于保存消息 ID 映射）
 */
async function loadMessageMappingText(botToken, superGroupChatId) {
  try {
    const resp = await callTelegramApi(botToken, 'getChat', { chat_id: superGroupChatId }, { context: '读取消息映射置顶' });
    const pinned = resp.result?.pinned_message;
    return {
      text: pinned?.text || '',
      messageId: pinned?.message_id || null
    };
  } catch (err) {
    console.error('loadMessageMappingText error', err);
    return { text: '', messageId: null };
  }
}

/**
 * 控制置顶消息长度，避免超过 Telegram 4096 字符限制
 * - 通过丢弃最早的映射记录来压缩长度
 */
function trimMappingText(text) {
  const parts = text.split(MESSAGE_MAPPING_SEPARATOR).filter(Boolean);
  let result = parts.join(MESSAGE_MAPPING_SEPARATOR);
  while (result.length > MAX_MESSAGE_MAPPING_LENGTH && parts.length > 1) {
    parts.shift();
    result = parts.join(MESSAGE_MAPPING_SEPARATOR);
  }
  return result;
}

/**
 * 将最新的消息映射追加到超管群置顶消息中
 * 如果有 KV 存储可用，优先使用 KV
 */
export async function addMessageMapping(botToken, superGroupChatId, topicId, topicMessageId, pmMessageId) {
  const kvStore = getKvStore();

  // 优先使用 KV 存储
  if (kvStore) {
    return addMessageMappingKV(kvStore, superGroupChatId, topicId, topicMessageId, pmMessageId);
  }

  // 回退到置顶消息方式
  const entry = `${topicId}-${topicMessageId}:${pmMessageId}`;
  const { text, messageId } = await loadMessageMappingText(botToken, superGroupChatId);

  // 尝试编辑已有置顶消息，否则创建新的置顶消息
  if (!messageId || !text) {
    const sendResp = await callTelegramApi(botToken, 'sendMessage', {
      chat_id: superGroupChatId,
      message_thread_id: 1,  // 发送到 General Topic (Forum 群组必须指定)
      text: entry
    }, { context: '创建消息映射置顶' });
    if (!sendResp.ok) {
      console.error('创建消息映射置顶消息失败', sendResp);
      return null;
    }
    const pinResp = await callTelegramApi(botToken, 'pinChatMessage', {
      chat_id: superGroupChatId,
      message_id: sendResp.result.message_id
    }, { context: '置顶消息映射' });
    if (!pinResp.ok) {
      console.error('置顶消息映射失败', pinResp);
    }
    return sendResp.result.message_id;
  }

  const newTextRaw = text ? `${text}${MESSAGE_MAPPING_SEPARATOR}${entry}` : entry;
  const newText = trimMappingText(newTextRaw);
  const editResp = await callTelegramApi(botToken, 'editMessageText', {
    chat_id: superGroupChatId,
    message_id: messageId,
    message_thread_id: 1,  // 编辑 General Topic 中的消息
    text: newText
  }, { context: '追加消息映射' });
  if (!editResp.ok) {
    console.error('更新消息映射失败', editResp);
  }
  return messageId;
}

/**
 * 根据私聊消息 ID 查找对应的 Topic 消息 ID
 * 如果有 KV 存储可用，优先使用 KV
 */
export async function findTopicMessageId(botToken, superGroupChatId, pmMessageId) {
  const kvStore = getKvStore();

  // 优先使用 KV 存储
  if (kvStore) {
    return findTopicMessageIdKV(kvStore, superGroupChatId, pmMessageId);
  }

  // 回退到置顶消息方式
  const { text } = await loadMessageMappingText(botToken, superGroupChatId);
  const entries = parseMessageMappings(text);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.pmMessageId === pmMessageId) {
      return { topicId: entry.topicId, topicMessageId: entry.topicMessageId };
    }
  }
  return { topicId: null, topicMessageId: null };
}

/**
 * 根据 Topic 消息 ID 查找对应的私聊消息 ID
 * 如果有 KV 存储可用，优先使用 KV
 */
export async function findPmMessageId(botToken, superGroupChatId, topicMessageId) {
  const kvStore = getKvStore();

  // 优先使用 KV 存储
  if (kvStore) {
    return findPmMessageIdKV(kvStore, superGroupChatId, topicMessageId);
  }

  // 回退到置顶消息方式
  const { text } = await loadMessageMappingText(botToken, superGroupChatId);
  const entries = parseMessageMappings(text);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.topicMessageId === topicMessageId) {
      return { topicId: entry.topicId, pmMessageId: entry.pmMessageId };
    }
  }
  return { topicId: null, pmMessageId: null };
}

/**
 * ========== KV 存储实现 ==========
 */

const MAX_KV_MAPPINGS = 1000;  // KV 中最多保存 1000 条映射

function getKvKey(superGroupChatId) {
  return `mapping:${superGroupChatId}`;
}

async function loadMappingsFromKV(kvStore, superGroupChatId) {
  if (!kvStore) return [];
  try {
    const key = getKvKey(superGroupChatId);
    const data = await kvStore.get(key, { type: 'json' });
    return data || [];
  } catch (err) {
    console.error('loadMappingsFromKV error', err);
    return [];
  }
}

async function saveMappingsToKV(kvStore, superGroupChatId, mappings) {
  if (!kvStore) return;
  try {
    const key = getKvKey(superGroupChatId);
    // 限制数组长度，FIFO 淘汰旧映射
    const trimmed = mappings.slice(-MAX_KV_MAPPINGS);
    await kvStore.put(key, JSON.stringify(trimmed));
  } catch (err) {
    console.error('saveMappingsToKV error', err);
  }
}

/**
 * 添加消息映射（KV 版本）
 */
export async function addMessageMappingKV(kvStore, superGroupChatId, topicId, topicMessageId, pmMessageId) {
  const mappings = await loadMappingsFromKV(kvStore, superGroupChatId);
  mappings.push({ topicId, topicMessageId, pmMessageId });
  await saveMappingsToKV(kvStore, superGroupChatId, mappings);
}

/**
 * 根据私聊消息 ID 查找对应的 Topic 消息 ID（KV 版本）
 */
export async function findTopicMessageIdKV(kvStore, superGroupChatId, pmMessageId) {
  const mappings = await loadMappingsFromKV(kvStore, superGroupChatId);
  for (let i = mappings.length - 1; i >= 0; i -= 1) {
    const entry = mappings[i];
    if (entry.pmMessageId === pmMessageId) {
      return { topicId: entry.topicId, topicMessageId: entry.topicMessageId };
    }
  }
  return { topicId: null, topicMessageId: null };
}

/**
 * 根据 Topic 消息 ID 查找对应的私聊消息 ID（KV 版本）
 */
export async function findPmMessageIdKV(kvStore, superGroupChatId, topicMessageId) {
  const mappings = await loadMappingsFromKV(kvStore, superGroupChatId);
  for (let i = mappings.length - 1; i >= 0; i -= 1) {
    const entry = mappings[i];
    if (entry.topicMessageId === topicMessageId) {
      return { topicId: entry.topicId, pmMessageId: entry.pmMessageId };
    }
  }
  return { topicId: null, pmMessageId: null };
}

/**
 * ========== Topic 映射 KV 存储 ==========
 */

function getTopicMappingKey(superGroupChatId) {
  return `topics:${superGroupChatId}`;
}

async function loadTopicMappingFromKV(kvStore, superGroupChatId) {
  if (!kvStore) return null;
  try {
    const key = getTopicMappingKey(superGroupChatId);
    const data = await kvStore.get(key, { type: 'json' });
    if (!data) return null;

    // 重建 Map 对象
    return {
      superGroupChatId: data.superGroupChatId,
      topicToFromChat: new Map(data.topicToFromChat || []),
      fromChatToTopic: new Map(data.fromChatToTopic || []),
      bannedTopics: data.bannedTopics || [],
      topicToComment: new Map(data.topicToComment || []),
      fromChatToComment: new Map(data.fromChatToComment || [])
    };
  } catch (err) {
    console.error('loadTopicMappingFromKV error', err);
    return null;
  }
}

async function saveTopicMappingToKV(kvStore, superGroupChatId, metaData) {
  if (!kvStore) return;
  try {
    const key = getTopicMappingKey(superGroupChatId);
    // 将 Map 转换为数组以便序列化
    const data = {
      superGroupChatId: metaData.superGroupChatId,
      topicToFromChat: Array.from(metaData.topicToFromChat.entries()),
      fromChatToTopic: Array.from(metaData.fromChatToTopic.entries()),
      bannedTopics: metaData.bannedTopics,
      topicToComment: Array.from(metaData.topicToComment.entries()),
      fromChatToComment: Array.from(metaData.fromChatToComment.entries())
    };
    await kvStore.put(key, JSON.stringify(data));
  } catch (err) {
    console.error('saveTopicMappingToKV error', err);
  }
}

/**
 * 加载元数据（KV 优先版本）
 */
export async function loadMetadataKV(botToken, ownerUid, superGroupChatId) {
  const kvStore = getKvStore();

  // 优先从 KV 读取
  if (kvStore && superGroupChatId) {
    const kvData = await loadTopicMappingFromKV(kvStore, superGroupChatId);
    if (kvData) return kvData;
  }

  // 回���到置顶消息
  const metaMessage = await loadMetadata(botToken, ownerUid);
  if (!metaMessage) return null;
  return parseMetaDataMessage(metaMessage);
}

/**
 * 更新元数据（KV 优先版本）
 */
export async function updateMappingKV(botToken, ownerUid, metaData) {
  const kvStore = getKvStore();

  // 优先保存到 KV
  if (kvStore) {
    await saveTopicMappingToKV(kvStore, metaData.superGroupChatId, metaData);
  }

  // 同时保存到置顶消息（备份）
  const metaMessage = await ensureMetadata(botToken, ownerUid, metaData.superGroupChatId);
  return editMetadata(botToken, ownerUid, metaMessage, trimMetadataEntries(metaData));
}

/**
 * 统一的元数据获取函数（KV 优先）
 * 自动从 KV 或置顶消息加载元数据
 */
export async function getMetadata(botToken, ownerUid, superGroupChatId = null) {
  const kvStore = getKvStore();

  // 优先从 KV 读取（如果提供了 superGroupChatId）
  if (kvStore && superGroupChatId) {
    const kvData = await loadTopicMappingFromKV(kvStore, superGroupChatId);
    if (kvData) return { metaData: kvData, metaMessage: null };
  }

  // 回退到置顶消息
  const metaMessage = await loadMetadata(botToken, ownerUid);
  if (!metaMessage) return { metaData: null, metaMessage: null };

  const metaData = parseMetaDataMessage(metaMessage);

  // 如果有 KV 且元数据有效，迁移到 KV
  if (kvStore && metaData && metaData.superGroupChatId) {
    await saveTopicMappingToKV(kvStore, metaData.superGroupChatId, metaData);
  }

  return { metaData, metaMessage };
}

/**
 * 清理指定 Topic 的所有消息映射（当 Topic 被删除时）
 */
export async function cleanupTopicMessages(superGroupChatId, topicId) {
  const kvStore = getKvStore();
  if (!kvStore) return;
  
  try {
    const mappings = await loadMappingsFromKV(kvStore, superGroupChatId);
    const before = mappings.length;
    const filtered = mappings.filter(m => m.topicId !== topicId);
    await saveMappingsToKV(kvStore, superGroupChatId, filtered);
    console.log('Cleaned up', before - filtered.length, 'message mappings for Topic', topicId);
  } catch (err) {
    console.error('cleanupTopicMessages error', err);
  }
}
