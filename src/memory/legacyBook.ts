import type { STMessage } from '@/st/context';

export const legacyExtraFields = ['leaf', 'group', 'hidden', 'omit', 'internal_notice'] as const;

function copyExtra(extra?: Record<string, unknown>): boolean {
  if (!extra || extra.rabbit_book_imported || !legacyExtraFields.some(f => 'bbs_' + f in extra)) return false;
  for (const field of legacyExtraFields) {
    const source = 'bbs_' + field;
    const target = 'rabbit_' + field;
    if (extra[source] !== undefined && !(target in extra)) {
      extra[target] = JSON.parse(JSON.stringify(extra[source]));
    }
  }
  // 删除或重摘后的摘要不能因再次打开聊天而被旧副本复活。
  extra.rabbit_book_imported = true;
  return true;
}

/** 仅复制柏宝书拥有的数据。楼号、叶子 id、父子关系和各 swipe 的归属均沿用原值。 */
export function copyBaiBaiChat(meta: Record<string, unknown>, chat: STMessage[]): boolean {
  let changed = false;
  for (const [source, target] of [['baibai_book', 'rabbit_book'], ['bbs_bundles', 'rabbit_bundles']]) {
    if (meta[source] !== undefined && !(target in meta)) {
      meta[target] = JSON.parse(JSON.stringify(meta[source]));
      changed = true;
    }
  }
  for (const message of chat) {
    if (copyExtra(message?.extra)) changed = true;
    for (const swipe of message?.swipe_info ?? []) {
      if (copyExtra(swipe?.extra)) changed = true;
    }
  }
  return changed;
}
