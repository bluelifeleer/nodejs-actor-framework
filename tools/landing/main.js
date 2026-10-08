/* 官网交互：主题切换、代码复制、示例 tab。全部原生 JS，无依赖。 */
(() => {
  const root = document.documentElement;
  const stored = (() => {
    try {
      return localStorage.getItem('actor-theme');
    } catch {
      return null;
    }
  })();
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  // 允许用 `?theme=dark|light` 强制（便于分享链接与截图核对）；否则用上次选择，再否则跟随系统
  const forced = new URLSearchParams(location.search).get('theme');
  const initial = forced === 'dark' || forced === 'light' ? forced : stored ?? (prefersDark ? 'dark' : 'light');
  root.dataset.theme = initial;

  const toggle = document.querySelector('[data-theme-toggle]');
  const label = () => (root.dataset.theme === 'dark' ? '☀ 浅色' : '☾ 深色');
  if (toggle) {
    toggle.textContent = label();
    toggle.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      toggle.textContent = label();
      try {
        localStorage.setItem('actor-theme', root.dataset.theme);
      } catch {
        /* 隐私模式无所谓 */
      }
    });
  }

  // 代码复制：按钮与它所在容器里的 <pre><code> 配对
  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', async () => {
      const scope = button.closest('.card, .cmd, .panel, section') ?? document;
      const code = scope.querySelector('pre code, code');
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent ?? '');
        button.textContent = '已复制';
        button.classList.add('done');
      } catch {
        button.textContent = '复制失败';
      }
      setTimeout(() => {
        button.textContent = '复制';
        button.classList.remove('done');
      }, 1600);
    });
  }

  // 示例 tab：键盘左右方向键也能切
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      const panel = document.getElementById(other.getAttribute('aria-controls') ?? '');
      if (panel) panel.hidden = !selected;
    }
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      if (next) {
        select(next);
        next.focus();
      }
    });
  }
})();
