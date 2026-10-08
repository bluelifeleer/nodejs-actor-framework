# __PLUGIN_NAME__

`@actor/mail` 的**邮件传输**骨架（`actor new plugin __PLUGIN_NAME__ --kind mail` 生成）。

契约只有一条：**能发就行**（`send` 返回 `{ id, accepted, rejected }`）。
重试、队列、模板渲染都不在这里 —— 那是投递语义层的事，框架不假装有保证。

## 自证合规

```bash
npm test     # 跑 @actor/mail 已发布的契约套件（离线，用假端点）
```

## 接到应用里

```ts
import { mailPlugin } from '@actor/mail';
import { __PLUGIN_CAMEL__Transport } from '__PLUGIN_NAME__';

createApp(defineApp({
  modules: [...],
  plugins: [mailPlugin({ transport: __PLUGIN_CAMEL__Transport({ endpoint: '…', apiKey: process.env.MAIL_KEY }) })],
}));
// 控制器里： const mail = ctx.get('mail') as MailTransport; await mail.send({ ... });
```
