import https from 'https';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../orchestrator/config.js';
import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import { registerChannel, ChannelOpts } from '../orchestrator/channel-registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../orchestrator/types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

/**
 * Download a Telegram photo by file_id, resize to max 1600px, save as JPEG.
 */
async function downloadTelegramPhoto(
  botToken: string,
  fileId: string,
  destPath: string,
): Promise<void> {
  const fileInfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
  const fileInfoRes = await fetch(fileInfoUrl);
  const fileInfo = (await fileInfoRes.json()) as any;
  if (!fileInfo.ok) throw new Error(`getFile failed: ${JSON.stringify(fileInfo)}`);

  const filePath = fileInfo.result.file_path as string;
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  const response = await fetch(downloadUrl);
  const buffer = Buffer.from(await response.arrayBuffer());

  await sharp(buffer)
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(destPath);
}

/**
 * Parse a Telegram JID into chatId and optional forum thread ID.
 * Format:  tg:<chatId>        — plain chat / group
 *          tg:<chatId>:t<n>   — forum topic thread n
 */
function parseTgJid(jid: string): { chatId: string; threadId?: number } {
  const body = jid.replace(/^tg:/, '');
  const tIdx = body.lastIndexOf(':t');
  if (tIdx !== -1) {
    const maybeId = parseInt(body.slice(tIdx + 2), 10);
    if (!isNaN(maybeId)) {
      return { chatId: body.slice(0, tIdx), threadId: maybeId };
    }
  }
  return { chatId: body };
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
const senderBotMap = new Map<string, number>(); // `${groupFolder}:${sender}` → pool index

// Persist assignments so bot names survive service restarts
const POOL_MAP_FILE = path.join(process.cwd(), 'store', 'pool-bot-map.json');

function loadPoolMap(): void {
  try {
    if (fs.existsSync(POOL_MAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(POOL_MAP_FILE, 'utf-8')) as Record<string, number>;
      for (const [k, v] of Object.entries(data)) {
        senderBotMap.set(k, v);
      }
      logger.info({ entries: senderBotMap.size }, 'Pool bot map loaded from disk');
    }
  } catch (err) {
    logger.warn({ err }, 'Could not load pool bot map from disk');
  }
}

function savePoolMap(): void {
  try {
    fs.mkdirSync(path.dirname(POOL_MAP_FILE), { recursive: true });
    const data: Record<string, number> = {};
    for (const [k, v] of senderBotMap.entries()) data[k] = v;
    fs.writeFileSync(POOL_MAP_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'Could not save pool bot map to disk');
  }
}

export async function initBotPool(tokens: string[]): Promise<void> {
  loadPoolMap(); // restore assignments from previous run
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    logger.warn({ sender }, 'No pool bots available, falling back to main bot');
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);

  if (idx === undefined) {
    // Find a free bot — never overwrite another sender's assignment
    const usedIndices = new Set(senderBotMap.values());
    const freeIdx = Array.from({ length: poolApis.length }, (_, i) => i)
      .find(i => !usedIndices.has(i));

    if (freeIdx === undefined) {
      // All pool bots taken — send from main bot instead of stealing
      logger.warn(
        { sender, groupFolder, poolSize: poolApis.length },
        'All pool bots assigned to other senders — falling back to main bot',
      );
      return;
    }

    idx = freeIdx;
    senderBotMap.set(key, idx);
    savePoolMap(); // persist so restarts remember the assignment

    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned and renamed pool bot');
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
    }
  }

  const api = poolApis[idx];
  try {
    const { chatId: numericId, threadId } = parseTgJid(chatId);
    const sendOpts = threadId ? { message_thread_id: threadId } : {};
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text, sendOpts);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(api, numericId, text.slice(i, i + MAX_LENGTH), sendOpts);
      }
    }
    logger.info({ chatId, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';
      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid, chatName }, 'Message from unregistered Telegram chat');
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: ctx.message.message_thread_id,
      });

      logger.info({ chatJid, chatName, sender: senderName }, 'Telegram message stored');
    });

    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
        thread_id: ctx.message?.message_thread_id,
      });
    };

    // Photo handler: download, resize, save — agent sees local file path
    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

      let content = `[Photo]${caption}`;
      try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];

        const mediaDir = path.join(process.cwd(), 'groups', group.folder, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });

        const dateStr = timestamp.replace(/[:.]/g, '-');
        const destPath = path.join(mediaDir, `${dateStr}_${ctx.message.message_id}.jpg`);

        await downloadTelegramPhoto(this.botToken, largest.file_id, destPath);
        content = `[Photo: ${destPath}]${caption}`;
        logger.info({ destPath }, 'Telegram photo downloaded and saved');
      } catch (err) {
        logger.warn({ err }, 'Failed to download Telegram photo, using placeholder');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: ctx.message.message_thread_id,
      });
    });

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(`  Send /chatid to the bot to get a chat's registration ID\n`);
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId } = parseTgJid(jid);
      const sendOpts = threadId ? { message_thread_id: threadId } : {};
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, chatId, text, sendOpts);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(this.bot.api, chatId, text.slice(i, i + MAX_LENGTH), sendOpts);
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const { chatId } = parseTgJid(jid);
      await this.bot.api.sendChatAction(chatId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
