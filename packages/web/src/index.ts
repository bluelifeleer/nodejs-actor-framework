/**
 * `@actor/web` —— Web 层（M2：路由 + 无状态控制器）。
 *
 * 边界规则与 `@actor/app` 相同：用户项目只依赖应用层包，不接触内核；
 * 本包不得 re-export 内核内部类型。
 */
export {
  defineWebPlugin,
  MIDDLEWARE_PHASES,
  orderMiddleware,
  runWebPluginContract,
  WEB_CONTEXT_HOOKS_SERVICE,
  type MiddlewarePhase,
  type PhasedMiddleware,
  type WebPluginSpec,
} from './plugins.ts';

export { httpPlugin, type HttpPlugin, type HttpPluginOptions } from './http.ts';
export { wsPlugin, type WsPlugin, type WsPluginOptions } from './ws.ts';
export {
  requestLogPlugin,
  type RequestLogEntry,
  type RequestLogPluginOptions,
} from './request-log.ts';
export {
  createConnectionRegistry,
  type MutableConnectionRegistry,
  type WsConnection,
  type WsConnections,
} from './connections.ts';

export { composeMiddleware, defineMiddleware, type Middleware } from './middleware.ts';
export {
  defineRouter,
  flattenRouter,
  flattenRoutes,
  routes,
  withMiddleware,
  type WithMiddleware,
  type RoutesTableSpec,
  type FlatRouteEntry,
  type RouteEntry,
  type RouteMeta,
  type RouterIssue,
  type RouterSpec,
} from './router.ts';

export {
  defineController,
  dispatch,
  type Controller,
  type ControllerSpec,
  type DispatchOptions,
  type DispatchRequest,
  type DispatchResult,
} from './controller.ts';

export {
  createRequestContext,
  HttpError,
  reply,
  toErrorResponse,
  toResponse,
  type Accessor,
  type AccessorObject,
  type HeaderValue,
  type HttpResponse,
  type HttpResponseInit,
  type RequestContext,
  type RequestContextInit,
} from './context.ts';

export {
  buildRouteTable,
  defineRoutes,
  del,
  get,
  head,
  HTTP_METHODS,
  matchRoute,
  normalizeMethod,
  options,
  parsePattern,
  patch,
  post,
  put,
  ROUTE_METHODS,
  ws,
  type ControllerLike,
  type HttpMethod,
  type MatchInput,
  type MatchResult,
  type Route,
  type RouteMethod,
  type RouteIssue,
} from './routes.ts';

// --- 文件上传（M8b）--------------------------------------------------------
export {
  diskChunkStore,
  memoryChunkStore,
  runChunkStoreContract,
  type ChunkSession,
  type ChunkSessionStore,
} from './upload/chunked.ts';

export {
  defineUploadStorage,
  localDiskStorage,
  memoryUploadStorage,
  runUploadStorageContract,
  type UploadStorage,
  type UploadedFile,
} from './upload/storage.ts';

export {
  DEFAULT_MULTIPART_LIMITS,
  parseBoundary,
  parseMultipart,
  type MultipartLimits,
  type MultipartPart,
  type MultipartSink,
} from './upload/multipart.ts';

export {
  STREAM_ROUTES_SERVICE,
  UPLOAD_STORAGE_SERVICE,
  uploadPlugin,
  type UploadPluginOptions,
} from './upload/plugin.ts';
