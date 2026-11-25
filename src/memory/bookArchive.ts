import { getContext, type STContext, type STMessage } from '@/st/context';
import { legacyExtraFields } from './legacyBook';

type Fields = Record<string, unknown>;
type Entry = { floor: number; page: number; slot: 'message' | 'swipe'; signature: string; data: Fields };
export type BookArchive = { key: string; meta: Fields; pages: Entry[] };
export const ARCHIVES = 'rabbit_book_chat_archives_v1';

export function archiveKey(owner: string, group: boolean, id: string): string {
  return JSON.stringify([group ? 'group' : 'character', owner, id]);
}
export function currentArchiveKey(ctx: STContext): string | undefined {
  const id = ctx.getCurrentChatId?.();
  if (!id) return;
  const avatar = ctx.characters?.[Number(ctx.characterId)]?.avatar;
  return archiveKey(String(ctx.groupId || avatar || ''), !!ctx.groupId, id);
}

function signature(msg: STMessage, text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return JSON.stringify([msg.send_date ?? '', msg.name, !!msg.is_user, text.length, hash]);
}

export function collectArchive(key: string, metadata: Fields, messages: STMessage[]): BookArchive | null {
  const meta: Fields = {};
  for (const [old, own] of [['baibai_book', 'rabbit_book'], ['bbs_bundles', 'rabbit_bundles']]) {
    if (metadata[old] !== undefined) meta[own] = metadata[old];
  }
  const pages: Entry[] = [];
  messages.forEach((msg, floor) => {
    const current = msg.swipe_id ?? 0;
    function collect(page: number, slot: Entry['slot'], text: string, extra?: Fields) {
      const data: Fields = {};
      for (const field of legacyExtraFields) {
        if (extra?.['bbs_' + field] !== undefined) data['rabbit_' + field] = extra['bbs_' + field];
      }
      if (Object.keys(data).length) pages.push({ floor, page, slot, signature: signature(msg, text), data });
    }
    // 保留消息本身和每页的独立副本，即使选中页的两个快照内容不同。
    collect(current, 'message', msg.mes, msg.extra);
    msg.swipe_info?.forEach((info, page) => collect(page, 'swipe', msg.swipes?.[page] ?? '', info?.extra));
  });
  return pages.length || Object.keys(meta).length ? { key, meta, pages } : null;
}

function fill(target: Fields, source: Fields) {
  for (const [k, value] of Object.entries(source)) {
    if (!Object.hasOwn(target, k)) target[k] = structuredClone(value);
  }
}

export function restoreArchive(archive: BookArchive, meta: Fields, messages: STMessage[], revision = archive.key) {
  if (meta.rabbit_book_archive_loaded === revision) return;
  fill(meta, archive.meta);
  const savedSwipes = new Set(archive.pages.filter(p => p.slot === 'swipe').map(p => p.floor + '/' + p.page));
  for (const { floor, page, slot, signature: expected, data } of archive.pages) {
    const msg = messages[floor];
    if (!msg) continue;
    const isCurrent = page === (msg.swipe_id ?? 0);
    const text = slot === 'message' && isCurrent ? msg.mes : msg.swipes?.[page];
    if (signature(msg, text ?? '') !== expected) continue;
    const apply = (extra: Fields) => {
      if (extra.rabbit_book_imported) return;
      fill(extra, data);
      extra.rabbit_book_imported = true;
    };
    if (isCurrent && slot === 'message') apply(msg.extra ??= {});
    const belongsToSwipe = slot === 'swipe' || (!isCurrent && !savedSwipes.has(floor + '/' + page));
    if (belongsToSwipe && (msg.swipe_info?.[page] || msg.swipes?.[page] !== undefined)) {
      const pages = msg.swipe_info ??= [];
      const info = pages[page] ??= {};
      apply(info.extra ??= {});
      if (isCurrent) apply(msg.extra ??= {});
    }
  }
  meta.rabbit_book_archive_loaded = revision;
}

export function archiveIndex(ctx: STContext): Record<string, string> {
  return (ctx.extensionSettings?.[ARCHIVES] ?? {}) as Record<string, string>;
}

export async function readArchive(path: string, key: string): Promise<BookArchive> {
  if (!/^\/(?:user\/)?files\/rabbit-book-[a-f0-9]+\.txt$/.test(path)) throw new Error('记忆副本路径无效');
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error('读取记忆副本失败（HTTP ' + res.status + '）');
  const data = await res.json() as BookArchive;
  if (data?.key !== key || !data.meta || !Array.isArray(data.pages)) throw new Error('记忆副本校验失败');
  return data;
}

const loading = new WeakMap<STMessage[], { key: string; promise: Promise<void> }>();
export async function loadArchivedMemory(onRestored: () => void): Promise<void> {
  const ctx = getContext();
  if (!ctx || !ctx.chat?.length || !ctx.chatMetadata) return;
  const key = currentArchiveKey(ctx);
  if (!key) return;
  const path = archiveIndex(ctx)[key];
  if (!path || ctx.chatMetadata.rabbit_book_archive_loaded === path) return;
  const chat = ctx.chat;
  const pending = loading.get(chat);
  if (pending?.key === key) return pending.promise;
  const promise = (async () => {
    const archive = await readArchive(path, key);
    const live = getContext();
    if (!live || live.chat !== chat || currentArchiveKey(live) !== key) return;
    restoreArchive(archive, live.chatMetadata, chat, path);
    onRestored();
    await live.saveChat();
  })();
  loading.set(chat, { key, promise });
  try { await promise; } finally { if (loading.get(chat)?.promise === promise) loading.delete(chat); }
}
