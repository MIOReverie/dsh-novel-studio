/**
 * 墨枢 Host 半：模型通道（`GET /models` / `POST /models`）。
 *
 * 模型列表来自宿主注入的 `ctx.llm`：
 *   listProviders() → [{ id, name }]        （也可能直接返回 id 字符串）
 *   listModels(id)  → [{ id, name }]        （也可能直接返回 id 字符串）
 * 某个 provider 的 listModels 抛错时只跳过它，绝不把整个请求打成 500。
 * 没有 llm 服务时返回 HTTP 200 + 空数组 + message（页面照常能打开）。
 */
import { HttpError } from './errors.js';
import * as store from './store.js';
import { writeSettingsPatch } from './settings.js';

const NO_LLM_MESSAGE = '宿主没有提供 llm 服务，请先在 DSH 里安装并启用模型插件；当前只能查看与修改设置。';

function providerIdOf(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object' && typeof entry.id === 'string') return entry.id.trim();
  return '';
}

function providerNameOf(entry, id) {
  if (entry && typeof entry === 'object' && typeof entry.name === 'string' && entry.name.trim()) return entry.name.trim();
  return id;
}

/** 把宿主返回的模型列表归一化成 `[{id,name}]`。 */
function normalizeModels(value) {
  if (!Array.isArray(value)) return [];
  const models = [];
  for (const entry of value) {
    const id = providerIdOf(entry);
    if (!id) continue;
    models.push({ id, name: typeof entry === 'object' && entry && typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id });
  }
  return models;
}

function llmOf(ctx) {
  return typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
}

/**
 * `GET /models`：`{ current, providers, message? }`。
 * @param {any} ctx cordis 上下文
 */
export async function describeModels(ctx) {
  const { settings } = store.projectContext();
  const current = { provider: settings.provider, model: settings.model };
  const llm = llmOf(ctx);
  if (!llm) return { current, providers: [], message: NO_LLM_MESSAGE };

  let rawProviders = [];
  try {
    rawProviders = typeof llm.listProviders === 'function' ? await llm.listProviders() : [];
  } catch {
    rawProviders = [];
  }
  if (!Array.isArray(rawProviders)) rawProviders = [];

  const providers = [];
  for (const entry of rawProviders) {
    const id = providerIdOf(entry);
    if (!id) continue;
    let models = [];
    try {
      models = normalizeModels(typeof llm.listModels === 'function' ? await llm.listModels(id) : []);
    } catch {
      // 这个通道的模型列表拿不到：跳过它，其它通道照常返回。
      continue;
    }
    providers.push({ id, name: providerNameOf(entry, id), models });
  }

  const payload = { current, providers };
  if (!providers.length) payload.message = '宿主没有注册任何可用的模型通道。';
  return payload;
}

/**
 * `POST /models`：写 provider / model 到 settings。
 * @param {{provider?:unknown, model?:unknown}} body
 */
export async function setModel(body) {
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!provider || provider.length > 200) throw new HttpError(400, 'provider 无效，请从模型列表里选一个通道。');
  if (!model || model.length > 200) throw new HttpError(400, 'model 无效，请从模型列表里选一个模型。');
  const settings = await writeSettingsPatch({ provider, model });
  return { provider: settings.provider, model: settings.model };
}
