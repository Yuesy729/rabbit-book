import { afterEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { STMessage } from '@/st/context';

afterEach(() => { vi.unstubAllGlobals(); });

it('opens imported memories, swipes and API settings after the original data is removed and the app restarts', async () => {
  const channel = { id: 'legacy-channel', name: '原渠道', model: 'fixture-model', key: 'fixture-only', url: 'https://example.invalid/v1' };
  const settings: Record<string, unknown> = {
    baibai_book: { assignments: { summary: channel.id, resummary: channel.id }, autoSummaryInterval: 3,
      channels: [channel], prompts: { summary: '旧提示词' }, ui: { theme: 'night' } },
    baibai_api_channels: { revision: 2, channels: [channel] },
  };
  const leaf = { id: 'leaf-old', text: '旧楼摘要', v: 1, swipe: 0, createdAt: 1, delta: { location: '江城' } };
  const chat: STMessage[] = [{ mes: '旧正文', name: '角色', is_user: false, is_system: false,
    extra: { bbs_leaf: leaf }, swipe_info: [{ extra: { bbs_leaf: leaf } }, { extra: { bbs_leaf: { ...leaf, id: 'alt', swipe: 1 } } }] }];
  const forest = { version: 3, summaries: [{ id: 'group-old', text: '旧总结', level: 1, createdAt: 2, auto: true, childIds: [leaf.id] }] };
  const meta: Record<string, unknown> = { baibai_book: forest };
  const ctx = { chat, chatMetadata: meta, extensionSettings: settings, getCurrentChatId: () => '旧聊天',
    saveChat: vi.fn(async () => {}), saveSettingsDebounced: vi.fn() };
  const boot = async () => {
    vi.resetModules();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { SillyTavern: { getContext: () => ctx } }));
    const api = await import('@/api/settings');
    const store = await import('./store');
    api.hydrateSettings();
    store.loadMemory();
    await nextTick();
    expect(api.getChannelForTask('summary')).toMatchObject(channel);
    expect(api.getChannelForTask('resummary')).toMatchObject(channel);
    expect(api.apiSettings.prompts.summary).toBe('旧提示词');
    expect(api.apiSettings.autoSummaryInterval).toBe(3);
    expect(store.derivedMeta.leaves.map(l => l.text)).toEqual(['旧楼摘要']);
    expect(store.memory.summaries).toMatchObject(forest.summaries);
    expect(store.memory.state.location).toBe('江城');
  };
  await boot();
  expect(ctx.saveChat).toHaveBeenCalled();
  expect(meta.rabbit_book).not.toBe(meta.baibai_book);
  expect(chat[0].extra?.rabbit_leaf).not.toBe(leaf);
  delete settings.baibai_book;
  delete settings.baibai_api_channels;
  delete meta.baibai_book;
  delete chat[0].extra!.bbs_leaf;
  for (const swipe of chat[0].swipe_info!) delete swipe!.extra!.bbs_leaf;
  Object.assign(ctx, JSON.parse(JSON.stringify({ chat, chatMetadata: meta, extensionSettings: settings })));
  await boot();
  expect(ctx.chat[0].swipe_info?.[1]?.extra?.rabbit_leaf).toMatchObject({ id: 'alt', swipe: 1 });
});

it('respects deletion after the first import', async () => {
  const { copyBaiBaiChat } = await import('./legacyBook');
  const chat = [{ name: '角色', mes: '正文', is_user: false, is_system: false, extra: { bbs_leaf: { id: 'old' } } }] as STMessage[];
  expect(copyBaiBaiChat({}, chat)).toBe(true);
  delete chat[0].extra!.rabbit_leaf;
  expect(copyBaiBaiChat({}, chat)).toBe(false);
  expect(chat[0].extra?.rabbit_leaf).toBeUndefined();
});
