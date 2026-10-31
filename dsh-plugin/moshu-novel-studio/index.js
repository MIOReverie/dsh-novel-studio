/**
 * 墨枢 · 小说工作台 —— Host 半。
 *
 * 运行在 DSH 进程内：
 * - 不启动独立服务，不自注册端口，只用宿主的 ctx.webServer 挂 /api/moshu/* 路由；
 * - 不读写 token / cookie，AI 能力直接取 ctx.llm（宿主注入的模型服务）；
 * - 作品数据仍在 <projectDir>/novels/<作品>/，Markdown 是权威源。
 *
 * Client 半（client.js）由 build.mjs 生成，负责左侧栏图标与整页 UI。
 */
import { createHandler, PREFIX } from './host/api.js';
import { setHostModelDefault } from './host/store.js';

export const name = 'moshu-novel-studio';

export const inject = ['webServer'];

/** 让墨枢跟随用户在 DSH 里选定的默认模型，而不是钉死某个 provider。 */
function bindHostModel(ctx) {
  const agentDefaultModel = ctx.get('agentDefaultModel');
  if (!agentDefaultModel || typeof agentDefaultModel.currentSelection !== 'function') return null;
  setHostModelDefault(() => agentDefaultModel.currentSelection());
  return () => setHostModelDefault(null);
}

/**
 * 挂载插件：注册一条 prefix 路由，并把它交给 ctx.effect 管理生命周期。
 * @param {any} ctx cordis 上下文
 */
export function apply(ctx) {
  const handler = createHandler(ctx);
  return ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler });
    const disposeModel = bindHostModel(ctx);
    if (ctx.logger && typeof ctx.logger.info === 'function') {
      ctx.logger.info(`[moshu] 已挂载 ${PREFIX}/*（Host 半，模型走 ctx.llm）`);
    }
    return () => {
      if (disposeModel) disposeModel();
      disposeRoute();
    };
  });
}
