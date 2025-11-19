/**
 * 消息分发入口
 * 负责 Webhook 收到的所有 Update 处理
 */

import { setKvStore } from './kvConfig.js';
import {
  ensureMetadata,
  loadMetadata,
  findPmMessageId,
  findTopicMessageId,
  parseMetaDataMessage,
  parseMetadataText,
  updateMapping
} from './metadataManager.js';
import { callTelegramApi } from './core.js';
import {
  changeBanStatus,
  forwardPrivateToTopic,
  forwardTopicToPrivate,
  isServiceMessage
} from './topicHandler.js';
import { banTopic, isTopicBanned, unbanTopic } from './banManager.js';
import { processMessageReaction } from './reactionHandler.js';
import { notifyMessageDeleted, notifyMessageEdited } from './deliveryStatus.js';

const HELP_TEXT = 'Fivegram 已启动。发送 /init 于绑定的超级群组以初始化元数据。';

// 统一的 API 调用包装，附带 owner 错误上报
const createApiCaller = (botToken, ownerUid, defaultContext = '') => (method, body, context = defaultContext) =>
  callTelegramApi(botToken, method, body, { ownerUid, context: context || defaultContext });

function buildStartText(message, ownerUid) {
  const isOwner = message.from?.id?.toString() === ownerUid?.toString();
  const isPrivate = message.chat?.type === 'private';
  const isTopic = Boolean(message.is_topic_message);

  if (isOwner && isPrivate) {
    return [
      '👋 欢迎回来，Owner！',
      '· 在绑定的超级群发送 /init 初始化或用 /status 查看映射',
      '· 私聊/话题内 #del 可删除对应消息，/ban /unban 仅在话题生效',
      '· /reset 可重新置顶元数据，支持 Fivegram 管理命令',
      '· 支持回复引用同步，基于 Cloudflare + KV 存储'
    ].join('\n');
  }

  if (isOwner && !isPrivate && !isTopic) {
    return [
      'This is Fivegram 控制台提示：',
      '· 在此群执行 /init 完成绑定，/status 查看当前配置',
      '· 进入对应话题可用 /ban /unban 或 #del 做清理',
      '· 确保机器人具备 can_delete_messages 与论坛权限'
    ].join('\n');
  }

  if (isTopic) {
    return [
      '👀 这是你的专属话题，群内回复会回到你的私聊。',
      '· 支持回复引用、编辑同步，#del 可申请删除',
      '· 若未收到私聊，可以再发一条消息建立映射'
    ].join('\n');
  }

  if (isPrivate) {
    return [
      '你好！我是 Fivegram。',
      '· 直接发送消息即可在群内生成独立论坛话题',
      '· 回复消息会同步引用，#del 可申请删除历史',
      '· 如需停止接收，请联系群管理员'
    ].join('\n');
  }

  return HELP_TEXT;
}

async function handleStartCommand(botToken, ownerUid, message) {
  const api = createApiCaller(botToken, ownerUid, '/start');
  const text = buildStartText(message, ownerUid);
  const payload = {
    chat_id: message.chat.id,
    text
  };
  if (message.is_topic_message) {
    payload.message_thread_id = message.message_thread_id;
  }
  await api('sendMessage', payload);
}

export async function handleUpdate(update, ctx) {
  const { ownerUid, botToken, messageMapping } = ctx;

  // 设置全局 KV 存储绑定
  if (messageMapping) {
    setKvStore(messageMapping);
  }

  const api = createApiCaller(botToken, ownerUid);

  // Emoji Reaction 更新
  if (update.message_reaction) {
    const metaMessage = await loadMetadata(botToken, ownerUid);
    if (!metaMessage) return new Response('OK');
    const metaData = parseMetaDataMessage(metaMessage);
    // 兜底填充超级群 ID，避免初始化异常导致 reaction 处理失败
    if (!metaData.superGroupChatId && update.message_reaction.chat?.type === 'supergroup') {
      metaData.superGroupChatId = update.message_reaction.chat.id;
    }
    await processMessageReaction(botToken, ownerUid, update.message_reaction, metaData);
    return new Response('OK');
  }

  // 编辑消息处理
  if (update.edited_message) {
    const metaMessage = await loadMetadata(botToken, ownerUid);
    if (!metaMessage) return new Response('OK');
    const metaData = parseMetaDataMessage(metaMessage);
    // 部分场景（如未初始化）尝试从更新中兜底填充超级群 ID
    if (!metaData.superGroupChatId && update.edited_message.chat?.type === 'supergroup') {
      metaData.superGroupChatId = update.edited_message.chat.id;
    }
    await processEditedMessage(botToken, ownerUid, update.edited_message, metaData, metaMessage);
    return new Response('OK');
  }

  const message = update.message;
  if (!message) return new Response('OK');

  const chat = message.chat;

  if (message.text?.startsWith('/start')) {
    await handleStartCommand(botToken, ownerUid, message);
    return new Response('OK');
  }

  if (message.text?.startsWith('/status')) {
    await handleStatus(botToken, ownerUid, message);
    return new Response('OK');
  }

  // 先检查是否为 #del 命令，必须通过回复触发
  if (message.reply_to_message && message.text?.trim() === '#del') {
    const metaMessage = await loadMetadata(botToken, ownerUid);
    const metaData = parseMetaDataMessage(metaMessage);
    // 兜底超级群 ID，避免未初始化导致删除逻辑无法执行
    if (!metaData.superGroupChatId && chat.type === 'supergroup') {
      metaData.superGroupChatId = chat.id;
    }
    const isDeleteCommand = await handleMessageDelete(botToken, ownerUid, message, metaData, metaMessage);
    if (isDeleteCommand) return new Response('OK');
  }

  if (await handleBanCommands(botToken, ownerUid, message)) {
    return new Response('OK');
  }

  // 超级群组维度的公共指令（如 /init）
  if (chat.type === 'supergroup' && await handleGroupWideCommands(botToken, ownerUid, message)) {
    return new Response('OK');
  }

  // 私聊：用户侧入口
  if (chat.type === 'private') {
    return handlePrivateChat(botToken, ownerUid, message);
  }

  // 超级群组且包含话题
  if (chat.type === 'supergroup' && message.is_topic_message) {
    return handleTopicMessage(botToken, ownerUid, message);
  }

  // 其他情况：简单指令或忽略
  if (message.text === '/start') {
    await api('sendMessage', {
      chat_id: chat.id,
      text: HELP_TEXT
    }, '/start 基础提示');
  }
  return new Response('OK');
}

/**
 * 处理编辑过的消息
 * - 区分 Owner 在超级群话题内的编辑，和用户在私聊中的编辑
 * - 仅支持文本消息编辑，媒体编辑暂未实现
 */
async function processEditedMessage(botToken, ownerUid, editedMessage, metaData, metaMessage) {
  const fromChat = editedMessage.chat;
  const fromUser = editedMessage.from;

  // Owner 在超级群话题内编辑消息，需同步到用户
  if (fromUser?.id?.toString() === ownerUid?.toString() && fromChat.id === metaData.superGroupChatId && fromChat.is_forum) {
    await processOwnerMessageEdit(botToken, ownerUid, editedMessage, metaData);
    return;
  }

  // 用户在私聊编辑消息，需同步到对应话题
  await processUserMessageEdit(botToken, ownerUid, editedMessage, metaData, metaMessage);
}

/**
 * 检测并处理 #del 删除命令
 * - 必须通过回复触发，且文本为 #del
 * - 根据执行人（owner/用户）分流到不同删除逻辑
 */
async function handleMessageDelete(botToken, ownerUid, message, metaData, metaMessage) {
  const api = createApiCaller(botToken, ownerUid, '删除命令');
  const reply = message.reply_to_message;
  if (!reply) return false; // 必须回复消息

  const messageText = message.text?.trim();
  if (messageText !== '#del') return false; // 必须是 #del 命令

  if (!metaData?.superGroupChatId) {
    // 元数据缺失时提示初始化，避免继续走普通消息流程
    await api('sendMessage', {
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id,
      text: '⚠️ 尚未初始化超级群，请先在群内执行 /init 后再试'
    });
    return true;
  }

  const fromChat = message.chat;
  const fromUser = message.from;

  // 判断是 owner 还是用户删除
  if (fromUser?.id?.toString() === ownerUid?.toString() && fromChat.id === metaData.superGroupChatId && fromChat.is_forum) {
    // Owner 删除：删除用户侧消息 + 自动清理 supergroup 的 3 条消息
    await processOwnerMessageDelete(botToken, ownerUid, message, reply, metaData, metaMessage);
  } else {
    // 用户删除：删除 supergroup 的消息 + 提示用户手动删除
    await processUserMessageDelete(botToken, ownerUid, message, reply, metaData, metaMessage);
  }

  return true; // 已处理
}

/**
 * 用户在私聊通过 #del 删除消息
 * - 仅删除超级群侧的同步消息
 * - 映射缺失时友好提示
 */
async function processUserMessageDelete(botToken, ownerUid, message, reply, metaData) {
  const api = createApiCaller(botToken, ownerUid, '用户删除');
  const commandMessageId = message.message_id;
  const originMessageId = reply.message_id;
  const fromChatId = message.chat.id;
  const topicId = metaData.fromChatToTopic.get(fromChatId);

  if (!topicId) {
    await api('sendMessage', {
      chat_id: fromChatId,
      text: '⚠️ 未找到对应话题映射，先发送一条消息建立映射后再试',
      reply_to_message_id: commandMessageId
    });
    return;
  }

  // 从映射查找对应的 topic 消息 ID
  const { topicMessageId: targetMessageId } = await findTopicMessageId(
    botToken,
    metaData.superGroupChatId,
    originMessageId
  );

  if (!targetMessageId) {
    await api('sendMessage', {
      chat_id: fromChatId,
      text: '⚠️ 无法找到要删除的消息，可能消息太旧或映射丢失',
      reply_to_message_id: commandMessageId
    });
    return;
  }

  // 删除 supergroup 中的消息（需要 bot 拥有 can_delete_messages 权限）
  const deleteResp = await api('deleteMessage', {
    chat_id: metaData.superGroupChatId,
    message_id: targetMessageId
  });

  if (deleteResp.ok) {
    // 成功，用 🗿 表情通知
    await notifyMessageDeleted(botToken, fromChatId, commandMessageId);

    // 提示用户手动删除原消息和命令消息
    await api('sendMessage', {
      chat_id: fromChatId,
      text: '✅ 消息已删除\n\n你可以手动删除原消息和 \\#del 命令消息',
      parse_mode: 'MarkdownV2'
    });
  } else {
    await api('sendMessage', {
      chat_id: fromChatId,
      text: `❌ 删除失败: ${deleteResp.description}`
    });
  }
}

/**
 * Owner 在超级群话题内通过 #del 删除消息
 * - 先删除用户私聊的对应消息
 * - 再自动清理超级群中的 origin/command/notify 三条消息
 */
async function processOwnerMessageDelete(botToken, ownerUid, message, reply, metaData) {
  const api = createApiCaller(botToken, ownerUid, 'Owner 删除');
  const commandMessageId = message.message_id;
  const topicId = message.message_thread_id;
  const deleteOriginMessageId = reply.message_id;
  const pmChatId = metaData.topicToFromChat.get(topicId);

  if (!pmChatId) {
    await api('sendMessage', {
      chat_id: metaData.superGroupChatId,
      message_thread_id: topicId,
      text: '⚠️ 未找到对应的私聊映射，无法删除'
    });
    return;
  }

  // 从映射查找对应的 pm 消息 ID
  const { pmMessageId: deleteTargetMessageId } = await findPmMessageId(
    botToken,
    metaData.superGroupChatId,
    deleteOriginMessageId
  );

  if (!deleteTargetMessageId) {
    await api('sendMessage', {
      chat_id: metaData.superGroupChatId,
      message_thread_id: topicId,
      text: '⚠️ 无法找到对应的私信消息，可能消息太旧或映射丢失'
    });
    return;
  }

  // 删除用户侧的消息
  const deleteResp = await api('deleteMessage', {
    chat_id: pmChatId,
    message_id: deleteTargetMessageId
  });

  if (!deleteResp.ok) {
    await api('sendMessage', {
      chat_id: metaData.superGroupChatId,
      message_thread_id: topicId,
      text: `❌ 删除失败: ${deleteResp.description}`
    });
    return;
  }

  // Owner 侧自动清理（需要 bot 拥有删除权限）
  await notifyMessageDeleted(botToken, metaData.superGroupChatId, commandMessageId);

  const notifyMsg = await api('sendMessage', {
    chat_id: metaData.superGroupChatId,
    message_thread_id: topicId,
    text: '✅ 消息已删除，以下 3 条消息将在 1 秒后自动删除',
    parse_mode: 'MarkdownV2'
  });

  // 1 秒后自动删除 origin、command、notify 三条消息
  await new Promise((resolve) => setTimeout(resolve, 1000));

  await api('deleteMessages', {
    chat_id: metaData.superGroupChatId,
    message_ids: [deleteOriginMessageId, commandMessageId, notifyMsg.result?.message_id].filter(Boolean)
  });
}

async function handlePrivateChat(botToken, ownerUid, message) {
  const api = createApiCaller(botToken, ownerUid, '私聊入口');

  // 忽略来自 bot 自己的消息
  if (message.from?.is_bot) {
    console.log('Ignoring message from bot itself');
    return new Response('OK');
  }

  // 忽略可能是 bot 自己发送的元数据消息
  const text = message.text?.trim();
  if (text && (/^-?\d+$/.test(text) || /^-\d+;/.test(text))) {
    console.log('Ignoring metadata message:', text.substring(0, 20));
    return new Response('OK');
  }

  const metaMessage = await loadMetadata(botToken, ownerUid);
  if (!metaMessage) {
    await api('sendMessage', {
      chat_id: message.chat.id,
      text: '尚未初始化，请先在超级群组中发送 /init 指令。'
    });
    return new Response('OK');
  }

  const metaData = parseMetaDataMessage(metaMessage);
  if (!metaData.superGroupChatId) {
    await api('sendMessage', {
      chat_id: message.chat.id,
      text: '超管群信息缺失，请重新执行 /init。'
    });
    return new Response('OK');
  }

  // 检查是否是 Supergroup 管理员
  const isAdmin = await isSupergroupAdmin(botToken, metaData.superGroupChatId, message.from?.id);
  if (isAdmin) {
    await api('sendMessage', {
      chat_id: message.chat.id,
      text: '作为 Supergroup 管理员，你不需要通过 Bot 发送消息。请直接在超级群的 Topic 中回复用户。'
    });
    return new Response('OK');
  }

  return forwardPrivateToTopic(botToken, ownerUid, metaData, metaMessage, message);
}

async function handleBanCommands(botToken, ownerUid, message) {
  const api = createApiCaller(botToken, ownerUid, 'Ban 命令');
  if (!message.text) return false;

  const commandConfig = {
    '/ban': { action: 'ban', silent: false },
    '/silent_ban': { action: 'ban', silent: true },
    '/unban': { action: 'unban', silent: false },
    '/silent_unban': { action: 'unban', silent: true }
  };

  const config = commandConfig[message.text];
  if (!config) return false;

  // 仅允许在对应超级群的话题中执行，避免误触
  if (message.chat.type !== 'supergroup' || !message.is_topic_message) {
    await api('sendMessage', {
      chat_id: message.chat.id,
      text: '请在绑定的超级群对应话题内执行拉黑命令。'
    });
    return true;
  }

  if (message.from?.id?.toString() !== ownerUid) {
    await api('sendMessage', {
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id,
      text: '仅机器人所有者可以执行拉黑/解除拉黑操作。'
    });
    return true;
  }

  const metaMessage = await loadMetadata(botToken, ownerUid);
  if (!metaMessage?.text) {
    await api('sendMessage', {
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id,
      text: '未找到元数据，请先在超级群发送 /init。'
    });
    return true;
  }

  const metaData = parseMetaDataMessage(metaMessage);
  metaData.superGroupChatId = metaData.superGroupChatId || message.chat.id;
  if (metaData.superGroupChatId !== message.chat.id) {
    await api('sendMessage', {
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id,
      text: '请在绑定的超级群内执行该命令。'
    });
    return true;
  }
  try {
    if (config.action === 'ban') {
      await banTopic(botToken, ownerUid, message, metaData, metaMessage, config.silent);
    } else {
      await unbanTopic(botToken, ownerUid, message, metaData, metaMessage, config.silent);
    }
  } catch (err) {
    await api('sendMessage', {
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id,
      text: `执行失败：${err.message || err}`
    });
  }

  return true;
}

/**
 * 用户编辑私聊消息 → 同步到超级群话题
 */
async function processUserMessageEdit(botToken, ownerUid, editedMessage, metaData) {
  const api = createApiCaller(botToken, ownerUid, '用户编辑同步');
  if (!metaData.superGroupChatId) return;
  const fromChatId = editedMessage.chat.id;
  const topicId = metaData.fromChatToTopic.get(fromChatId);
  if (!topicId) return;
  if (isTopicBanned(metaData, topicId)) return;

  // 根据私聊消息 ID 查找对应的 Topic 消息 ID
  const { topicId: mappingTopicId, topicMessageId } = await findTopicMessageId(
    botToken,
    metaData.superGroupChatId,
    editedMessage.message_id
  );
  const targetTopicId = mappingTopicId || topicId;

  // 映射不存在时，重新复制一条消息并提示
  if (!topicMessageId) {
    await sendNewMessageWithEditHint(botToken, ownerUid, metaData.superGroupChatId, targetTopicId, editedMessage);
    return;
  }

  // 仅支持文本消息的编辑同步
  if (editedMessage.text) {
    const editResp = await api('editMessageText', {
      chat_id: metaData.superGroupChatId,
      message_id: topicMessageId,
      text: editedMessage.text,
      entities: editedMessage.entities
    });

    if (editResp.ok) {
      await notifyMessageEdited(botToken, fromChatId, editedMessage.message_id);
    } else if (editResp.description?.includes("can't be edited")) {
      await sendNewMessageWithEditHint(botToken, ownerUid, metaData.superGroupChatId, targetTopicId, editedMessage);
    }
  } else {
    await api('sendMessage', {
      chat_id: metaData.superGroupChatId,
      message_thread_id: targetTopicId,
      text: '⚠️ 仅支持文本消息编辑，媒体消息编辑功能待实现'
    });
  }
}

/**
 * Owner 在话题内编辑消息 → 同步到对应用户的私聊消息
 */
async function processOwnerMessageEdit(botToken, ownerUid, editedMessage, metaData) {
  const api = createApiCaller(botToken, ownerUid, 'Owner 编辑同步');
  if (!metaData.superGroupChatId) return;
  const topicId = editedMessage.message_thread_id;
  const pmChatId = metaData.topicToFromChat.get(topicId);
  if (!pmChatId) return;

  // 查找对应的私聊消息 ID
  const { pmMessageId } = await findPmMessageId(botToken, metaData.superGroupChatId, editedMessage.message_id);
  if (!pmMessageId) {
    await api('sendMessage', {
      chat_id: metaData.superGroupChatId,
      message_thread_id: topicId,
      text: '⚠️ 无法找到对应的私信消息，可能消息太旧或映射丢失'
    });
    return;
  }

  // 同步文本编辑
  if (editedMessage.text) {
    const editResp = await api('editMessageText', {
      chat_id: pmChatId,
      message_id: pmMessageId,
      text: editedMessage.text,
      entities: editedMessage.entities
    });

    if (editResp.ok) {
      await notifyMessageEdited(botToken, metaData.superGroupChatId, editedMessage.message_id);
    } else if (editResp.description?.includes("can't be edited")) {
      const resendResp = await api('sendMessage', {
        chat_id: pmChatId,
        text: editedMessage.text,
        entities: editedMessage.entities
      }, '重新发送编辑消息');

      if (resendResp.ok) {
        await api('sendMessage', {
          chat_id: metaData.superGroupChatId,
          message_thread_id: topicId,
          text: '⬆️⬆️⬆️ 消息过旧，已重新发送最新内容到用户私聊'
        });
      }
    } else {
      await api('sendMessage', {
        chat_id: metaData.superGroupChatId,
        message_thread_id: topicId,
        text: `编辑失败: ${editResp.description}`
      });
    }
  } else {
    await api('sendMessage', {
      chat_id: metaData.superGroupChatId,
      message_thread_id: topicId,
      text: '⚠️ 仅支持文本消息编辑'
    });
  }
}

/**
 * 当原消息无法编辑时，复制一条新消息并提示
 */
async function sendNewMessageWithEditHint(botToken, ownerUid, superGroupChatId, topicId, editedMessage) {
  const api = createApiCaller(botToken, ownerUid, '编辑兜底');
  await api('copyMessage', {
    chat_id: superGroupChatId,
    from_chat_id: editedMessage.chat.id,
    message_id: editedMessage.message_id,
    message_thread_id: topicId
  });

  await api('sendMessage', {
    chat_id: superGroupChatId,
    message_thread_id: topicId,
    text: '⬆️⬆️⬆️ 消息已编辑（原消息太旧或无法编辑，已重新发送）',
    parse_mode: 'MarkdownV2'
  });
}

async function handleTopicMessage(botToken, ownerUid, message) {
  if (isServiceMessage(message)) {
    return new Response('OK');
  }

  // 管理指令在 topic 内执行
  if (await handleTopicCommands(botToken, ownerUid, message)) {
    return new Response('OK');
  }

  const metaMessage = await loadMetadata(botToken, ownerUid);
  if (!metaMessage?.text) return new Response('OK');
  const metaData = parseMetaDataMessage(metaMessage);
  if (metaData.superGroupChatId !== message.chat.id) return new Response('OK');

  // 检查这个 Topic 对应的用户是否是管理员
  const targetChatId = metaData.topicToFromChat.get(message.message_thread_id);
  if (targetChatId) {
    const isAdmin = await isSupergroupAdmin(botToken, metaData.superGroupChatId, targetChatId);
    if (isAdmin) {
      console.log('Skip forwarding: User is Supergroup admin');
      return new Response('OK');
    }
  }

  // 被禁言的 Topic 不允许向私聊发送
  if (isTopicBanned(metaData, message.message_thread_id)) {
    return new Response('OK');
  }

  return forwardTopicToPrivate(botToken, ownerUid, metaData, metaMessage, message);
}

async function handleTopicCommands(botToken, ownerUid, message) {
  if (!message.text?.startsWith('/')) return false;
  const command = message.text.split(' ')[0];
  if (command === '/ban') {
    const metaMessage = await loadMetadata(botToken, ownerUid);
    if (!metaMessage) return true;
    const metaData = parseMetaDataMessage(metaMessage);
    metaData.superGroupChatId = metaData.superGroupChatId || message.chat.id;
    await changeBanStatus(botToken, ownerUid, metaData, metaMessage, message.message_thread_id, true);
    return true;
  }
  if (command === '/unban') {
    const metaMessage = await loadMetadata(botToken, ownerUid);
    if (!metaMessage) return true;
    const metaData = parseMetaDataMessage(metaMessage);
    metaData.superGroupChatId = metaData.superGroupChatId || message.chat.id;
    await changeBanStatus(botToken, ownerUid, metaData, metaMessage, message.message_thread_id, false);
    return true;
  }
  return false;
}

async function handleStatus(botToken, ownerUid, message) {
  const api = createApiCaller(botToken, ownerUid, '/status');
  const metaMessage = await loadMetadata(botToken, ownerUid);
  if (!metaMessage?.text) {
    await api('sendMessage', {
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id,
      text: '⚠️ 尚未初始化，先在绑定的超级群发送 /init。'
    });
    return;
  }

  const metaData = parseMetaDataMessage(metaMessage);
  const summary = [
    `超级群 ID：${metaData.superGroupChatId || '未记录'}`,
    `映射数量：${metaData.topicToFromChat.size}`,
    `拉黑话题：${metaData.bannedTopics.length}`,
    `元数据长度：${(metaMessage.text || '').length}/4096`
  ].join('\n');

  const payload = {
    chat_id: message.chat.id,
    text: `当前配置状态：\n${summary}`
  };
  if (message.is_topic_message) {
    payload.message_thread_id = message.message_thread_id;
  }
  await api('sendMessage', payload);
}

// 超级群组内 /init 处理
async function handleInit(botToken, ownerUid, message) {
  const api = createApiCaller(botToken, ownerUid, '/init');
  try {
    const existing = await loadMetadata(botToken, ownerUid);
    if (existing?.text) {
      const parsed = parseMetadataText(existing.text);
      const boundGroupId = parsed.superGroupChatId || message.chat.id;
      if (boundGroupId === message.chat.id) {
        await api('sendMessage', {
          chat_id: message.chat.id,
          text: '已检测到元数据置顶消息，无需重复初始化。使用 /status 查看当前状态。'
        });
        return;
      }
    }

    const metaMessage = await ensureMetadata(botToken, ownerUid, message.chat.id);
    const metaData = parseMetadataText(metaMessage.text || `${message.chat.id}`);
    metaData.superGroupChatId = message.chat.id;
    await updateMapping(botToken, ownerUid, metaMessage, metaData);
    await api('sendMessage', {
      chat_id: message.chat.id,
      text: '初始化完成，后续私聊消息会按 Topic 隔离。'
    });
  } catch (err) {
    await api('sendMessage', {
      chat_id: message.chat.id,
      text: `初始化失败: ${err.message}`
    });
  }
}

async function handleReset(botToken, ownerUid, message) {
  const api = createApiCaller(botToken, ownerUid, '/reset');
  await api('unpinAllChatMessages', { chat_id: ownerUid });
  if (message.chat?.id) {
    // 尝试同时清理超级群的置顶（保存消息映射的 pinned message），避免旧映射干扰
    await api('unpinAllChatMessages', { chat_id: message.chat.id });
  }
  await api('sendMessage', {
    chat_id: message.chat.id,
    text: '已清空元数据，请重新 /init'
  });
}

async function handleGroupWideCommands(botToken, ownerUid, message) {
  if (!message.text) return false;
  const cmd = message.text.split(' ')[0];
  if (cmd === '/init') {
    await handleInit(botToken, ownerUid, message);
    return true;
  }
  if (cmd === '/reset') {
    await handleReset(botToken, ownerUid, message);
    return true;
  }
  if (cmd === '/status') {
    await handleStatus(botToken, ownerUid, message);
    return true;
  }
  return false;
}

/**
 * 检查用户是否是 Supergroup 的管理员
 */
export async function isSupergroupAdmin(botToken, supergroupId, userId) {
  try {
    const resp = await callTelegramApi(botToken, 'getChatMember', {
      chat_id: supergroupId,
      user_id: userId
    }, { context: '检查管理员身份' });

    const status = resp.result?.status;
    return status === 'creator' || status === 'administrator';
  } catch (err) {
    console.error('isSupergroupAdmin error', err);
    return false;
  }
}
