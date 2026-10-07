/**
 * 自带的前端示例页面（同源，所以不需要 CORS）。
 *
 * 覆盖：小文件（`POST /uploads`，单/多文件）、大文件（分片 + 并发 + 失败重传 + **断点续传**）、
 * 整文件 sha256 用 **WebCrypto** 算、每个分片的 sha256 也逐片校验。
 */
export const demoPage = `<!doctype html>
<html lang="zh">
<meta charset="utf-8" />
<title>@actor/web 上传示例</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 820px; }
  fieldset { margin-bottom: 1.2rem; }
  progress { width: 100%; height: 1.2rem; }
  pre { background: #f6f6f6; padding: .6rem; overflow: auto; }
</style>
<h1>上传示例</h1>

<fieldset>
  <legend>① 小文件：一次 multipart（单/多文件）</legend>
  <input id="small" type="file" multiple />
  <button id="smallBtn">上传</button>
</fieldset>

<fieldset>
  <legend>② 大文件：分片 + 并发 + 重传 + 断点续传</legend>
  <input id="big" type="file" />
  <button id="bigBtn">开始上传</button>
  <button id="resumeBtn">继续上次（断点续传）</button>
  <div><progress id="bar" value="0" max="100"></progress> <span id="pct">0%</span></div>
</fieldset>

<pre id="log"></pre>

<script>
const CHUNK = 5 * 1024 * 1024;          // 必须 >= 5MiB（后端下限）
const CONCURRENCY = 4;
const RETRIES = 3;
const log = (msg) => { const el = document.getElementById('log'); el.textContent += msg + '\\n'; el.scrollTop = el.scrollHeight; };

/** 整块/分片 sha256（十六进制）—— 用 WebCrypto，浏览器里直接算。 */
async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 带重试的 PUT 分片（网络抖动/服务端 5xx 都能重来；sha256 逐片校验保证写进去的就是这一片）。 */
async function putChunk(uploadId, index, blob) {
  const chunkSha = await sha256Hex(blob);
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await fetch('/uploads/chunked/' + uploadId + '/' + index, {
        method: 'PUT',
        headers: { 'x-chunk-sha256': chunkSha },
        body: blob,
      });
      if (res.ok) return await res.json();
      const text = await res.text();
      if (res.status < 500 && res.status !== 429) throw new Error('分片 ' + index + ' 被拒：' + res.status + ' ' + text);
      log('分片 ' + index + ' 第 ' + attempt + ' 次失败（' + res.status + '），重试…');
    } catch (err) {
      if (attempt === RETRIES) throw err;
      log('分片 ' + index + ' 出错（' + err.message + '），重试…');
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  throw new Error('分片 ' + index + ' 重试耗尽');
}

/** 查状态：返回还缺哪些分片（这就是"断点续传"的入口）。 */
async function missingChunks(uploadId) {
  const res = await fetch('/uploads/chunked/' + uploadId);
  if (res.status === 404) return null;          // 会话过期/不存在 → 需要重新 init
  const state = await res.json();
  return state.missing;
}

async function initUpload(file) {
  const sha256 = await sha256Hex(file);         // 整个文件的 sha256（complete 时后端会核对）
  log('整文件 sha256 = ' + sha256);
  const res = await fetch('/uploads/chunked/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: file.name, size: file.size, chunkSize: CHUNK, sha256 }),
  });
  if (!res.ok) throw new Error('init 失败：' + res.status + ' ' + (await res.text()));
  const session = await res.json();
  localStorage.setItem('actor-upload', JSON.stringify({ uploadId: session.uploadId, name: file.name, size: file.size, sha256 }));
  return { session, sha256 };
}

/** 把缺口补完（并发 + 重试），然后 complete。 */
async function uploadMissing(file, uploadId, missing, total) {
  const queue = [...missing];
  let done = total - queue.length;
  const bump = () => { done += 1; const pct = Math.round((done / total) * 100); document.getElementById('bar').value = pct; document.getElementById('pct').textContent = pct + '%'; };
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      const blob = file.slice(index * CHUNK, Math.min((index + 1) * CHUNK, file.size));
      await putChunk(uploadId, index, blob);
      bump();
    }
  });
  await Promise.all(workers);
  const res = await fetch('/uploads/chunked/' + uploadId + '/complete', { method: 'POST' });
  const text = await res.text();
  if (!res.ok) throw new Error('complete 失败：' + res.status + ' ' + text);   // 整文件 sha256 不符会在这里报出期望/实际
  localStorage.removeItem('actor-upload');
  return JSON.parse(text).file;
}

document.getElementById('smallBtn').onclick = async () => {
  const files = document.getElementById('small').files;
  if (!files.length) return;
  const form = new FormData();
  form.append('note', '来自示例页面');
  for (const file of files) form.append('file', file, file.name);
  const res = await fetch('/uploads', { method: 'POST', body: form });
  const text = await res.text();
  log('小文件上传 → ' + res.status + ' ' + text);
  if (res.ok) for (const saved of JSON.parse(text).files) log('  可回读：/uploads/' + saved.key);
};

document.getElementById('bigBtn').onclick = async () => {
  const file = document.getElementById('big').files[0];
  if (!file) return;
  document.getElementById('bar').value = 0;
  try {
    const { session, sha256 } = await initUpload(file);
    log('init 成功：uploadId=' + session.uploadId + '，共 ' + session.totalChunks + ' 片，已收 ' + JSON.stringify(session.received));
    const saved = await uploadMissing(file, session.uploadId, session.missing, session.totalChunks);
    log('✅ 上传完成：' + JSON.stringify(saved));
    log('   回读地址：/uploads/' + saved.key + '（sha256 应当等于 ' + sha256 + '）');
  } catch (err) { log('❌ ' + err.message); }
};

// 断点续传：刷新页面后仍能从 localStorage 拿到 uploadId，先查状态再补缺口
document.getElementById('resumeBtn').onclick = async () => {
  const saved = JSON.parse(localStorage.getItem('actor-upload') || 'null');
  if (!saved) { log('没有未完成的上传'); return; }
  const missing = await missingChunks(saved.uploadId);
  if (missing === null) { log('会话已过期，需要重新开始'); localStorage.removeItem('actor-upload'); return; }
  log('续传：uploadId=' + saved.uploadId + '，还缺 ' + JSON.stringify(missing));
  const file = document.getElementById('big').files[0];
  if (!file || file.name !== saved.name) { log('请重新选择同一个文件（' + saved.name + '）再点继续'); return; }
  const total = Math.ceil(file.size / CHUNK);
  const result = await uploadMissing(file, saved.uploadId, missing, total);
  log('✅ 续传完成：' + JSON.stringify(result));
};
</script>
</html>`;
