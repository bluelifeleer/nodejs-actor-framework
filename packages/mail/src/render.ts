import { DbConfigError } from '@actor/resource';

/**
 * **极简占位渲染**：`{{name}}` 替换，**默认转义**（HTML 里尤其重要：不转义就是 XSS 直通车）。
 * 需要真正的模板引擎（EJS/Handlebars…）就通过 `renderer` 注入，框架不内建、也不假装内建。
 */
export interface RenderMailOptions {
  /** HTML 里默认转义；显式 `escape: false` 才关（**知道自己在干什么再用**）。 */
  escape?: boolean;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] as string);
}

/** `{{key}}` 占位替换；缺的键**保留原文**（不静默渲染成空字符串）。 */
export function renderTemplate(template: string, data: Record<string, unknown>, options: RenderMailOptions = {}): string {
  if (typeof template !== 'string') throw new DbConfigError('renderTemplate: template 必须是字符串');
  const escape = options.escape !== false;
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key: string) => {
    const value = key.split('.').reduce<unknown>((acc, part) => {
      if (acc === null || typeof acc !== 'object') return undefined;
      return (acc as Record<string, unknown>)[part];
    }, data);
    if (value === undefined) return whole; // 缺键保留原文，便于一眼看出漏了什么
    const text = String(value);
    return escape ? escapeHtml(text) : text;
  });
}

/** 注入点：想用真模板引擎就传自己的实现。 */
export type MailRenderer = (template: string, data: Record<string, unknown>) => string;

export function createRenderer(): MailRenderer {
  return (template, data) => renderTemplate(template, data, { escape: true });
}
