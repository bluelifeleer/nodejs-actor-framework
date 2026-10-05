/**
 * `@actor/web` —— Web 层（M2：路由 + 无状态控制器）。
 *
 * 边界规则与 `@actor/app` 相同：用户项目只依赖应用层包，不接触内核；
 * 本包不得 re-export 内核内部类型。
 */
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
  matchRoute,
  parsePattern,
  patch,
  post,
  put,
  type ControllerLike,
  type HttpMethod,
  type MatchInput,
  type MatchResult,
  type Route,
  type RouteIssue,
} from './routes.ts';
