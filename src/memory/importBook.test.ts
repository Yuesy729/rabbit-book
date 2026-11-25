import { afterEach, expect, it, vi } from 'vitest';
import { archiveKey, collectArchive, loadArchivedMemory, restoreArchive } from './bookArchive';
import type { STMessage } from '@/st/context';

afterEach(() => vi.unstubAllGlobals());

const msg = (text: string): STMessage => ({
  name: '角色', mes: text, is_user: false, is_system: false, send_date: 'old',
  extra: { bbs_leaf: { id: 'main', text: '旧摘要' } }, swipe_id: 0, swipes: [text, '其他回复'],
  swipe_info: [{ extra: { bbs_leaf: { id: 'current-swipe' } } }, { extra: { bbs_leaf: { id: 'alternate' } } }],
});

it('imports settings and unopened chats, verifies files, retries a broken chat, and works after removing the source', async () => {
  const endpoint = { key: 'fake-key-for-test', url: 'https://example.invalid', model: 'model-A' };
  const ext: Record<string, any> = { rabbit_book: { channels: [{ id: 'rabbit-only' }], autoSummaryInterval: 3 },
    baibai_book: { prompts: { summary: '旧摘要词' }, assignments: { summary: 'old', resummary: 'old' }, vector: { embedding: endpoint } },
    baibai_api_channels: { channels: [{ ...endpoint, id: 'old' }] },
    baibai_exclude_settings: { excludedChars: ['排除角色'] } };
  const archiveFiles = new Map<string, string>();
  const chats = [{ group: 'group1', file_name: '同名.jsonl' }, { avatar: 'A.png', file_name: '同名.jsonl' }, { avatar: 'B.png', file_name: '新.jsonl' }];
  const forest = { version: 3, summaries: [{ id: 'group-old', text: '旧总结' }] };
  const groupMetadata = { baibai_book: { group: true } };
  let bad = true;
  let settingsOnDisk = '';
  let active: string | undefined;
  const ctx = {
    extensionSettings: ext, getRequestHeaders: () => ({}), getCurrentChatId: () => active,
    saveSettingsDebounced: vi.fn(), saveSettings: async () => { settingsOnDisk = JSON.stringify({ extension_settings: ext }); },
    groups: [{ id: 'group1', chat_id: '同名', chat_metadata: groupMetadata }],
    chat: [] as STMessage[], chatMetadata: {} as Record<string, any>, characters: [{ avatar: 'A.png' }], characterId: 0,
    saveChat: vi.fn(async () => {}),
  };
  vi.stubGlobal('window', Object.assign(new EventTarget(), { SillyTavern: { getContext: () => ctx } }));
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url === '/api/chats/recent') return Response.json(chats);
    if (url === '/api/chats/export') {
      if (bad && body.is_group) return Response.json({ result: '{broken' });
      const rows = body.is_group ? [msg('群聊')] : body.avatar_url === 'B.png' ? [{ chat_metadata: {} }] :
        [{ chat_metadata: { baibai_book: forest, bbs_bundles: ['旧包'] } }, msg('未打开过的正文')];
      return Response.json({ result: rows.map(x => JSON.stringify(x)).join('\n') });
    }
    if (url === '/api/files/upload') {
      const path = '/user/files/' + body.name;
      archiveFiles.set(path, Buffer.from(body.data, 'base64').toString('utf8'));
      return Response.json({ path });
    }
    if (archiveFiles.has(url)) return new Response(archiveFiles.get(url));
    if (url === '/api/settings/get') return Response.json({ settings: settingsOnDisk });
    throw new Error('Unexpected network request');
  });
  const { importAllBaiBai, importStatus } = await import('./importBook');
  await importAllBaiBai();
  expect(importStatus).toMatchObject({ done: 3, copied: 1, empty: 1 });
  expect(importStatus.errors).toHaveLength(1);
  bad = false;
  await importAllBaiBai();
  expect(importStatus).toMatchObject({ copied: 1, existing: 1, empty: 1, errors: [], settings: '柏宝书设置已保存' });
  expect(archiveFiles.size).toBe(2);
  expect(ctx.saveChat).not.toHaveBeenCalled();
  expect(ext.rabbit_book).toMatchObject({ assignments: ext.baibai_book.assignments, prompts: { summary: '旧摘要词' },
    autoSummaryInterval: 3, vector: { embedding: endpoint }, excludedChars: ['排除角色'] });
  expect(ext.rabbit_book.channels).toEqual(expect.arrayContaining([expect.objectContaining(endpoint), expect.objectContaining({ id: 'rabbit-only' })]));
  for (const [path, data] of archiveFiles) {
    expect(data).not.toContain(endpoint.key);
    expect(data).not.toContain('未打开过的正文');
    if (JSON.parse(data).key === archiveKey('group1', true, '同名')) expect(JSON.parse(data).meta.rabbit_book).toEqual({ group: true });
    expect(path).toContain('/user/files/');
  }
  delete ext.baibai_book;
  delete ext.baibai_api_channels;
  delete ext.baibai_exclude_settings;
  active = '同名';
  const clean = msg('未打开过的正文');
  delete clean.extra;
  delete clean.swipe_info;
  ctx.chat = [clean];
  await loadArchivedMemory(() => {});
  expect(ctx.chatMetadata.rabbit_book).toEqual(forest);
  expect(ctx.chatMetadata.rabbit_bundles).toEqual(['旧包']);
  expect(clean.extra).toMatchObject({ rabbit_leaf: { id: 'main' } });
  expect(ctx.chat[0].swipe_info?.[0]?.extra).toMatchObject({ rabbit_leaf: { id: 'current-swipe' } });
  expect(ctx.chat[0].swipe_info?.[1]?.extra).toMatchObject({ rabbit_leaf: { id: 'alternate' } });
});

it('keeps native edits and never attaches a past leaf to a replacement message', () => {
  const archive = collectArchive('key', {}, [msg('旧正文'), msg('正文')])!;
  const other = msg('新正文'); other.extra = {};
  const edited = msg('正文'); edited.extra = { rabbit_book_imported: true };
  restoreArchive(archive, {}, [other, edited]);
  expect(other.extra.rabbit_leaf).toBeUndefined();
  expect(edited.extra.rabbit_leaf).toBeUndefined();
});
