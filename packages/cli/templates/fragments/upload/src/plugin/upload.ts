import { uploadPlugin, localDiskStorage } from '@actor/web';

/**
 * 文件上传能力（`--web-plugins upload`）：流式单/多文件 + 分片断点续传。
 *
 * 数据落在 `./data/uploads`（`APP_UPLOAD_DIR` 可改）。要换成 S3/OSS 就实现 `UploadStorage`
 * 并传给 `uploadPlugin({ storage })`；分片会话存储换成共享实现即可多节点部署。
 */
export default uploadPlugin({
  storage: localDiskStorage({ dir: process.env['APP_UPLOAD_DIR'] ?? './data/uploads' }),
});
