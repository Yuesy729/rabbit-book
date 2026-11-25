// 这些是每台设备上的视图偏好。复制后写入兔之书自己的键，旧插件可独立移除。
const suffixes = ['ui.page.v1', 'orb.pos.v1', 'ui.lifeCollapsed.v1', 'ui.planCollapsed.v1',
  'ui.suspenseCollapsed.v1', 'scenes.collapsed.v1'];

export function importLocalPrefs(overwrite = false): boolean {
  let found = false;
  try {
    for (const suffix of suffixes) {
      const value = localStorage.getItem('bbs.' + suffix);
      if (value === null) continue;
      found = true;
      const key = 'rabbit-book.' + suffix;
      if (overwrite || localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }
  } catch { /* 浏览器禁用本机存储时，账号设置仍然可用。 */ }
  return found;
}
