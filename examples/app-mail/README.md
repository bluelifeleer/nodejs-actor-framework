# app-mail：邮件（离线可跑）

```bash
cd examples/app-mail
node main.ts        # 启动时会写一封欢迎信到 data/mail/*.eml，并在控制台打印文件路径
curl -s localhost:PORT/send
```

- 用的是 **`fileTransport`**：零依赖、不需要任何邮件服务，产物就是标准 `.eml`（可以直接用邮件客户端打开）。
- 换成真 SMTP：`npm i nodemailer`，然后 `mailPlugin({ driver: 'smtp', url: 'smtp://user:pass@host:587' })`
  （或配置 `plugins.mail.url`）—— **代码别的地方都不用改**。
- 生命周期（连接/探活/关闭）由 `@actor/resource` 的 `supervise()` 提供；邮件也在
  `/__debug/health` 的受管资源清单里（配上 `debugPlugin` 就能看到）。
- 想验证真投递：`node scripts/dev-databases.mjs up mailhog`，然后设 `ACTOR_TEST_SMTP_URL` 跑 `npm test`。

细节见指南 [docs/guide/16-mail.md](../../docs/guide/internals/16-mail.md)。
