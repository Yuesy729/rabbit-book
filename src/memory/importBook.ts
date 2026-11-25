import { nextTick, reactive } from 'vue';
import { importBaiBaiSettings } from '@/api/settings';
import { getContext, type STContext, type STMessage } from '@/st/context';
import { ARCHIVES, archiveIndex, archiveKey, collectArchive, currentArchiveKey, readArchive, type BookArchive } from './bookArchive';

export const importStatus = reactive({
  busy: false, done: 0, total: 0, copied: 0, existing: 0, empty: 0,
  settings: '', message: '', errors: [] as string[],
});
type Recent = { file_name: string; avatar?: string; group?: string | number };
type LegacyGroup = { id: string | number; chat_id: string; chat_metadata?: Record<string, unknown>;
  past_metadata?: Record<string, Record<string, unknown>> };

async function post(ctx: STContext, url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error('酒馆接口 ' + url + ' 返回 HTTP ' + res.status);
  return res.json();
}

async function saveArchive(ctx: STContext, archive: BookArchive) {
  const bytes = new TextEncoder().encode(JSON.stringify(archive));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  const uid = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  const { path } = await post(ctx, '/api/files/upload', { name: 'rabbit-book-' + uid + '.txt', data: btoa(binary) });
  const saved = await readArchive(path, archive.key);
  if (JSON.stringify(saved) !== JSON.stringify(archive)) throw new Error('记忆副本与原数据不符');
  return path as string;
}

async function importChat(ctx: STContext, item: Recent) {
  const id = item.file_name.replace(/\.jsonl$/i, '');
  const isGroup = item.group != null;
  const key = archiveKey(String(item.group ?? item.avatar ?? ''), isGroup, id);
  const index = archiveIndex(ctx);
  const oldPath = index[key];
  let prior: BookArchive | undefined;
  if (oldPath) {
    try {
      prior = await readArchive(oldPath, key);
    } catch { /* 副本不可读时从原记录重建。 */ }
  }
  const group = isGroup ? (ctx.groups as LegacyGroup[] | undefined)?.find(g => String(g.id) === String(item.group)) : undefined;
  let meta = (id === group?.chat_id ? group?.chat_metadata : group?.past_metadata?.[id]) ?? {};
  let chat: STMessage[];
  const live = getContext();
  if (live && currentArchiveKey(live) === key && live.chat?.length) {
    chat = live.chat;
    meta = { ...meta, ...live.chatMetadata };
  } else {
    // 原始 JSONL 逐行严格解析。损坏的记录单独报错，绝不回写历史聊天文件。
    const raw = await post(ctx, '/api/chats/export', {
      avatar_url: item.avatar ?? '', ...(isGroup ? { is_group: true } : {}),
      file: item.file_name, format: 'jsonl', exportfilename: item.file_name,
    });
    if (typeof raw.result !== 'string' || !raw.result.trim()) throw new Error('聊天文件为空或无法读取');
    let rows;
    try { rows = raw.result.trim().split(/\r?\n/).filter((line: string) => line.trim()).map((line: string) => JSON.parse(line)); }
    catch { throw new Error('聊天文件有无法解析的记录'); }
    if (rows[0] && !('mes' in rows[0])) meta = { ...meta, ...rows.shift().chat_metadata };
    if (!rows.every((row: STMessage) => typeof row?.mes === 'string')) throw new Error('聊天消息格式无法识别');
    chat = rows;
  }
  const archive = collectArchive(key, meta, chat);
  if (!archive && prior) return 'existing';
  if (!archive && oldPath) throw new Error('已有副本不可读，源聊天无可恢复的数据');
  if (!archive) return 'empty';
  if (prior) {
    // 只增补来源仍提供的字段。再次导入或中途断线不会抹掉独立副本。
    archive.meta = { ...prior.meta, ...archive.meta };
    const pages = new Map<string, BookArchive['pages'][number]>();
    for (const entry of [...prior.pages, ...archive.pages]) {
      const slot = JSON.stringify([entry.floor, entry.page, entry.slot, entry.signature]);
      const previous = pages.get(slot);
      pages.set(slot, previous ? { ...entry, data: { ...previous.data, ...entry.data } } : entry);
    }
    archive.pages = Array.from(pages.values());
    if (JSON.stringify(archive) === JSON.stringify(prior)) return 'existing';
  }
  const path = await saveArchive(ctx, archive);
  index[key] = path;
  ctx.extensionSettings![ARCHIVES] = index;
  ctx.saveSettingsDebounced?.();
  return 'copied';
}

// 使用宿主自身的保存流程，再回读服务器确认四个兔之书键已落盘。
async function verifySettings(ctx: STContext) {
  await nextTick();
  const scriptPath = '/script.js';
  const save = ctx.saveSettings ?? (await import(/* @vite-ignore */ scriptPath)).saveSettings;
  await save();
  const { settings } = await post(ctx, '/api/settings/get', {});
  let stored;
  try { stored = JSON.parse(settings).extension_settings; }
  catch { throw new Error('无法校验酒馆保存的设置'); }
  for (const key of [ARCHIVES, 'rabbit_book', 'rabbit_book_api_channels', 'rabbit_book_exclude_settings']) {
    if (JSON.stringify(stored?.[key]) !== JSON.stringify(ctx.extensionSettings?.[key])) {
      throw new Error('设置尚未保存到酒馆，请稍后重试');
    }
  }
}

export async function importAllBaiBai() {
  if (importStatus.busy) return;
  Object.assign(importStatus, { busy: true, done: 0, total: 0, copied: 0, existing: 0, empty: 0,
    settings: '', message: '正在读取柏宝书设置和聊天列表…', errors: [] });
  try {
    const ctx = getContext();
    if (!ctx?.extensionSettings) throw new Error('酒馆还没加载好');
    const hasSettings = importBaiBaiSettings();
    importStatus.settings = hasSettings ? '已读取柏宝书设置' : '未找到柏宝书全局设置';
    const list = await post(ctx, '/api/chats/recent', { max: Number.MAX_SAFE_INTEGER });
    if (!Array.isArray(list) || !list.every(x => typeof x?.file_name === 'string')) throw new Error('无法取得完整聊天列表');
    importStatus.total = list.length;
    importStatus.message = '正在复制聊天记忆…';
    for (const item of list) {
      try { importStatus[await importChat(ctx, item)]++; }
      catch (error) {
        importStatus.errors.push(String(item.group ?? item.avatar ?? '聊天') + ' / ' + item.file_name + ' · ' + (error instanceof Error ? error.message : '读取失败'));
      }
      importStatus.done++;
    }
    await verifySettings(ctx);
    if (hasSettings) importStatus.settings = '柏宝书设置已保存';
    importStatus.message = importStatus.errors.length ? '部分聊天导入失败，可再次点击导入重试。' : '导入检查完成。';
  } catch (error) {
    importStatus.message = '导入未完成';
    importStatus.errors.push(error instanceof Error ? error.message : '请检查酒馆连接后重试');
  } finally { importStatus.busy = false; }
}
