import { HttpError } from '../context.ts';

/**
 * **流式 `multipart/form-data` 解析**（零依赖）：边读边写，超限**立刻** 413。
 *
 * 只实现必要子集（足够浏览器 `<input type=file>` / `FormData` 用）：
 *   - 每个 part 的头（`content-disposition` 的 `name`/`filename`、`content-type`）；
 *   - 文件 part 走 `onFile()` 返回的 sink（**流式**，不整块进内存）；
 *   - 普通字段累积到 `fields`（受 `maxFieldSize` 限制）；
 *   - 畸形/截断/超限 → 抛 `HttpError`（400/413），由 http 层映射成响应。
 *
 * 安全前提：**不信任** `filename`（只当元数据）；key 由服务端生成；`name` 里不接受路径语义。
 */
export interface MultipartLimits {
  maxFileSize: number;
  maxFiles: number;
  maxFieldSize: number;
  maxFields: number;
}

export interface MultipartPart {
  /** 表单字段名。 */
  readonly name: string;
  /** 原始文件名（普通字段为 null）。 */
  readonly filename: string | null;
  readonly mimeType: string;
}

export interface MultipartSink {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

export const DEFAULT_MULTIPART_LIMITS: MultipartLimits = {
  maxFileSize: 512 * 1024 * 1024,
  maxFiles: 20,
  maxFieldSize: 64 * 1024,
  maxFields: 100,
};

/** 从 content-type 里取 boundary（缺失或不合法 → 400）。 */
export function parseBoundary(contentType: string): string {
  const match = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  const boundary = match?.[1] ?? match?.[2];
  if (boundary === undefined || boundary === '') {
    throw new HttpError(400, 'multipart/form-data 缺少 boundary');
  }
  if (boundary.length > 200) throw new HttpError(400, 'multipart boundary 太长');
  return boundary;
}

function parseHeaders(block: string): MultipartPart {
  let name = '';
  let filename: string | null = null;
  let mimeType = 'application/octet-stream';
  for (const line of block.split('\r\n')) {
    const lower = line.toLowerCase();
    if (lower.startsWith('content-disposition:')) {
      const value = line.slice('content-disposition:'.length);
      name = /;\s*name\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(value)?.[1] ?? /;\s*name\s*=\s*([^;\s]+)/i.exec(value)?.[1] ?? '';
      const fileMatch = /;\s*filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(value);
      const raw = fileMatch?.[1] ?? fileMatch?.[2];
      if (raw !== undefined && raw !== '') {
        // 只保留**基名**，去掉任何路径成分（客户端可能塞 ../../etc/passwd）
        filename = raw.split(/[/\\]/).pop() ?? raw;
      }
    } else if (lower.startsWith('content-type:')) {
      mimeType = line.slice('content-type:'.length).trim();
    }
  }
  if (name === '') throw new HttpError(400, 'multipart part 缺少 name');
  return { name, filename, mimeType };
}

export async function parseMultipart(
  source: AsyncIterable<Uint8Array>,
  options: {
    contentType: string;
    limits?: Partial<MultipartLimits>;
    /** 文件 part 开始时的回调：返回接收数据的 sink（抛错即中断整个上传）。 */
    onFile: (part: MultipartPart) => MultipartSink;
    /** 字段 part 结束时回调（默认收进返回值）。 */
    onField?: (name: string, value: string) => void;
  },
): Promise<{ fields: Record<string, string>; fileCount: number }> {
  const limits: MultipartLimits = { ...DEFAULT_MULTIPART_LIMITS, ...(options.limits ?? {}) };
  const boundary = parseBoundary(options.contentType);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  // 请求体**开头**是 `--boundary`（没有前导 CRLF）；后续分界才有 CRLF
  const openDelimiter = Buffer.from(`--${boundary}`);

  const fields: Record<string, string> = {};
  let pending = Buffer.alloc(0);
  let started = false;
  let state: 'headers' | 'body' = 'headers';
  interface CurrentPart {
    part: MultipartPart;
    sink: MultipartSink | null;
    fieldChunks: Buffer[];
    fieldSize: number;
  }
  // 用 holder 对象：赋值发生在闭包里，TS 对 `let` 的跨闭包收窄会误判成 never
  const partState: { current: CurrentPart | null } = { current: null };
  let fileCount = 0;
  let fieldCount = 0;
  let finished = false;

  const toBuffer = (chunk: Uint8Array): Buffer =>
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

  /** 把一段数据交给当前 part（文件 → sink；字段 → 累积）。**唯一出口**，避免漏掉某条路径。 */
  const pushData = async (slice: Buffer): Promise<void> => {
    if (slice.length === 0) return;
    const active = partState.current;
    if (active === null) return;
    if (active.sink !== null) {
      await active.sink.write(slice);
      return;
    }
    active.fieldSize += slice.byteLength;
    if (active.fieldSize > limits.maxFieldSize) {
      throw new HttpError(413, `字段超过上限（maxFieldSize=${limits.maxFieldSize}）：${active.part.name}`);
    }
    active.fieldChunks.push(Buffer.from(slice));
  };

  const endPart = async (): Promise<void> => {
    if (partState.current === null) return;
    if (partState.current.sink !== null) {
      await partState.current.sink.finish();
      fileCount += 1;
    } else {
      const value = Buffer.concat(partState.current.fieldChunks).toString('utf8');
      if (options.onField !== undefined) options.onField(partState.current.part.name, value);
      else fields[partState.current.part.name] = value;
      fieldCount += 1;
    }
    partState.current = null;
  };

  const abortPart = async (): Promise<void> => {
    if (partState.current?.sink != null) await partState.current.sink.abort().catch(() => undefined);
    partState.current = null;
  };

  const startPart = (part: MultipartPart): void => {
    if (part.filename !== null) {
      if (fileCount + 1 > limits.maxFiles) throw new HttpError(413, `文件数超过上限（maxFiles=${limits.maxFiles}）`);
      const sink = options.onFile(part);
      let written = 0;
      partState.current = {
        part,
        sink: {
          write: async (chunk) => {
            written += chunk.byteLength;
            if (written > limits.maxFileSize) {
              throw new HttpError(413, `文件超过上限（maxFileSize=${limits.maxFileSize}）：${part.filename}`);
            }
            await sink.write(chunk);
          },
          finish: () => sink.finish(),
          abort: () => sink.abort(),
        },
        fieldChunks: [],
        fieldSize: 0,
      };
      return;
    }
    if (fieldCount + 1 > limits.maxFields) throw new HttpError(413, `字段数超过上限（maxFields=${limits.maxFields}）`);
    partState.current = { part, sink: null, fieldChunks: [], fieldSize: 0 };
  };

  for await (const chunk of source) {
    pending = Buffer.concat([pending, toBuffer(chunk)]);
    let progressed = true;
    while (progressed && !finished) {
      progressed = false;

      if (state === 'headers') {
        if (!started) {
          // 容忍（真实客户端不会发的）前导 CRLF
          if (pending.length >= 2 && pending[0] === 0x0d && pending[1] === 0x0a) pending = pending.subarray(2);
          if (pending.length < openDelimiter.length) break;
          if (!pending.subarray(0, openDelimiter.length).equals(openDelimiter)) {
            throw new HttpError(400, 'multipart 起始边界不符');
          }
          pending = pending.subarray(openDelimiter.length);
          started = true;
          progressed = true;
          continue;
        }
        if (pending.length >= 2 && pending[0] === 0x2d && pending[1] === 0x2d) {
          finished = true;
          break; // --boundary-- 收尾
        }
        let head = pending;
        if (head.length >= 2 && head[0] === 0x0d && head[1] === 0x0a) head = head.subarray(2);
        const headerEnd = head.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          if (head.length > 16 * 1024) throw new HttpError(400, 'multipart part 头过大');
          break; // 等更多数据
        }
        const block = head.subarray(0, headerEnd).toString('utf8');
        pending = head.subarray(headerEnd + 4);
        startPart(parseHeaders(block));
        state = 'body';
        progressed = true;
        continue;
      }

      // state === 'body'
      const index = pending.indexOf(delimiter);
      if (index >= 0) {
        await pushData(pending.subarray(0, index));
        await endPart();
        pending = pending.subarray(index + delimiter.length);
        state = 'headers';
        progressed = true;
        continue;
      }
      // 安全刷出：保留可能不完整的定界符尾巴
      const safeLength = pending.length - (delimiter.length + 4);
      if (safeLength > 0) {
        const slice = pending.subarray(0, safeLength);
        pending = pending.subarray(safeLength);
        await pushData(slice);
      }
    }
    if (finished) break;
  }

  if (!finished) {
    await abortPart();
    throw new HttpError(400, 'multipart 数据提前结束（缺少收尾边界）');
  }
  return { fields, fileCount };
}
