/**
 * 墨枢 Host 半：作者可编辑的设置（`.moshu/settings.json`）。
 *
 * 这个模块是「设置项长什么样」的唯一出处：字段表、默认值、范围、校验都在这里。
 * 契约 v2 规定：未知键一律 400，值超范围一律 400。
 *
 * 读盘每次都重新读，不缓存 —— 改完设置不用重启 DSH。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.js';
import { withPathLock } from './jsonstore.js';
import { novelsRootOf } from './scope.js';
import {
  defaultModelSelection,
  isInside,
  loadSettings,
  validateNovelName,
  writeJson,
} from './store.js';

/** 审阅重点输入框的初始文案（契约 v2 默认值）。 */
export const DEFAULT_REVIEW_FOCUS = '检查剧情因果、人物动机、前后逻辑、设定冲突和语言表达。';

/**
 * 设置字段表：类型 + 范围 + 说明。
 * `editable` 的键就是作者能在设置页里改的全部内容。
 */
export const SETTINGS_SCHEMA = Object.freeze({
  provider: { type: 'string', required: true, maxLength: 200, description: '模型通道' },
  model: { type: 'string', required: true, maxLength: 200, description: '模型 id' },
  novelDir: { type: 'string', required: true, maxLength: 200, description: '当前作品目录名' },
  reviewFocus: { type: 'string', maxLength: 300, description: '审阅重点' },
  maxAnnotations: { type: 'number', min: 1, max: 20, description: '每次审阅最多几条批注' },
  allowRewriteSuggestion: { type: 'boolean', description: '批注建议可否含 ≤40 字示范片段' },
  autosaveDelayMs: { type: 'number', min: 600, max: 6000, description: '自动保存延迟（毫秒）' },
  backupKeep: { type: 'number', min: 0, max: 200, description: '每文档保留备份份数，0=不清理' },
  editorFontSize: { type: 'number', min: 13, max: 22, description: '正文字号' },
  editorSerif: { type: 'boolean', description: '正文衬线' },
  lineNumbers: { type: 'boolean', description: '默认显示行号' },
  contextRelatedDocs: { type: 'number', min: 0, max: 8, description: 'AI 附带的相关资料条数' },
  contextMemories: { type: 'number', min: 0, max: 30, description: 'AI 附带的记忆条数' },
  language: { type: 'string', values: ['zh', 'en'], description: '界面语言' },
  exportFormat: { type: 'string', values: ['md', 'txt'], description: '导出格式' },
});

/** 可编辑键（顺序固定，前端可按这个顺序渲染设置页）。 */
export const EDITABLE_KEYS = Object.freeze(Object.keys(SETTINGS_SCHEMA));

/** 旧后端用过的作品名字段，读取时兼容。 */
const LEGACY_NOVEL_KEYS = ['novel', 'novelName'];

/**
 * 默认设置（`GET /settings` 的 `defaults`）。
 * provider / model 跟随宿主当前选择；宿主没给就用契约兜底。
 */
export function defaultSettings() {
  const { provider, model } = defaultModelSelection();
  return {
    provider,
    model,
    /* v3：默认作品目录改为空串 —— 不再假装磁盘上有一本《雾隐之城》。
       「当前作品是哪一本」由 current-book.js 解析（配置值 → 扫描 novels/ → null），
       这里只是「配置的默认值」，两者不能混为一谈。 */
    novelDir: '',
    reviewFocus: DEFAULT_REVIEW_FOCUS,
    maxAnnotations: 8,
    allowRewriteSuggestion: false,
    autosaveDelayMs: 1600,
    backupKeep: 30,
    editorFontSize: 15,
    editorSerif: true,
    lineNumbers: true,
    contextRelatedDocs: 4,
    contextMemories: 10,
    language: 'zh',
    exportFormat: 'md',
  };
}

/** 每个键的取值范围（`GET /settings` 的 `ranges`，前端用来生成控件与提示）。 */
export function settingsRanges() {
  const ranges = {};
  for (const [key, rule] of Object.entries(SETTINGS_SCHEMA)) {
    const item = { type: rule.type };
    if (rule.min !== undefined) item.min = rule.min;
    if (rule.max !== undefined) item.max = rule.max;
    if (rule.maxLength !== undefined) item.maxLength = rule.maxLength;
    if (rule.values) item.values = [...rule.values];
    if (rule.description) item.description = rule.description;
    ranges[key] = item;
  }
  return ranges;
}

/** 实际读写的 settings.json（存在就用它，否则落在 `<projectDir>/.moshu/settings.json`）。 */
export function settingsFile() {
  const loaded = loadSettings();
  /* 有作用域时写到该对话自己的 settings.json：这样「当前作品」是每个对话独立的，
     不会出现 A 窗口切书、B 窗口跟着变。 */
  if (loaded.scopeFile) return loaded.scopeFile;
  if (loaded.file) return loaded.file;
  return path.join(loaded.projectDir, '.moshu', 'settings.json');
}

/** 读 settings.json 的原始内容（坏文件视为空对象，不抛错）。 */
export function readSettingsFile() {
  const file = settingsFile();
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * 校验单个设置值。
 * @param {string} key
 * @param {unknown} value
 * @returns {string|number|boolean} 归一化后的值
 */
export function validateSettingValue(key, value) {
  const rule = SETTINGS_SCHEMA[key];
  if (!rule) throw new HttpError(400, `未知的设置项「${key}」。`);

  if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') throw new HttpError(400, `设置项「${key}」必须是 true 或 false。`);
    return value;
  }

  if (rule.type === 'number') {
    const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    if (!Number.isFinite(number)) throw new HttpError(400, `设置项「${key}」必须是数字。`);
    if (!Number.isInteger(number)) throw new HttpError(400, `设置项「${key}」必须是整数。`);
    if (number < rule.min || number > rule.max) {
      throw new HttpError(400, `设置项「${key}」必须在 ${rule.min} ~ ${rule.max} 之间。`);
    }
    return number;
  }

  if (typeof value !== 'string') throw new HttpError(400, `设置项「${key}」必须是字符串。`);
  const text = value.trim();
  if (rule.values && !rule.values.includes(text)) {
    throw new HttpError(400, `设置项「${key}」只能是 ${rule.values.map((item) => `「${item}」`).join(' / ')}。`);
  }
  if (rule.required && !text) throw new HttpError(400, `设置项「${key}」不能为空。`);
  if (rule.maxLength !== undefined && text.length > rule.maxLength) {
    throw new HttpError(400, `设置项「${key}」最多 ${rule.maxLength} 个字。`);
  }
  return text;
}

/**
 * 生效中的设置 = 默认值 ← settings.json 里的合法覆盖。
 * 文件里个别脏值只影响那一项（回退默认），不会让整页打不开。
 * @returns {ReturnType<typeof defaultSettings>}
 */
export function readSettings() {
  const settings = defaultSettings();
  const raw = readSettingsFile();

  if (!Object.prototype.hasOwnProperty.call(raw, 'novelDir')) {
    for (const legacy of LEGACY_NOVEL_KEYS) {
      if (typeof raw[legacy] !== 'string' || !raw[legacy].trim()) continue;
      try {
        settings.novelDir = validateSettingValue('novelDir', raw[legacy]);
      } catch {
        /* 旧字段也脏，就用默认作品名 */
      }
      break;
    }
  }

  for (const key of EDITABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    try {
      settings[key] = validateSettingValue(key, raw[key]);
    } catch {
      /* 脏值回退默认值 */
    }
  }
  return settings;
}

/**
 * novelDir 必须是 `<projectDir>/novels/` 下**真实存在**的目录。
 *
 * 这里只做「存在 + 不越界」，不再套用新建书时的命名规则：
 * 磁盘上本来就有、但名字带首尾空格或超过 40 字的老目录/外部目录，
 * 也必须能切过去——否则它会"列得出来、点不动"。
 */
function assertNovelDirExists(novelDir) {
  const name = typeof novelDir === 'string' ? novelDir : '';
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new HttpError(400, `作品目录「${name}」不合法。`);
  }
  const loaded = loadSettings();
  /* 必须是**当前作用域**的书库：每个对话有自己的 novels/，
     以前这里写死全局 `<projectDir>/novels`，于是在对话里新建的书
     （落在 `.moshu/scopes/<id>/novels/`）会被判成"不存在"，新建直接失败。 */
  const novelsRoot = novelsRootOf(loaded.projectDir);
  const target = path.join(novelsRoot, name);
  if (!isInside(novelsRoot, target)) throw new HttpError(400, `作品目录「${name}」不在 novels/ 之内。`);
  let stat;
  try {
    stat = statSync(target);
  } catch {
    throw new HttpError(400, `作品「${name}」不存在，请先在书籍菜单里新建这本书。`);
  }
  if (!stat.isDirectory()) throw new HttpError(400, `作品「${name}」不是一个目录。`);
  return name;
}

/**
 * 应用一次设置 patch：先整体校验，再原子写盘（要么全生效，要么一条都不动）。
 * @param {unknown} patch
 * @returns {Promise<ReturnType<typeof defaultSettings>>} 写盘后的生效设置
 */
export async function writeSettingsPatch(patch) {
  /* 读-改-写必须串行：并发补丁（切书写 novelDir + 设置页写字号）以前会互相覆盖，
     实测 6 轮里丢了 4 次 novelDir —— 丢一次就等于「下次打开换了一本书」。 */
  const file = settingsFile();
  return withPathLock(`settings:${file}`, () => writeSettingsPatchUnlocked(patch, file));
}

async function writeSettingsPatchUnlocked(patch, file) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new HttpError(400, 'patch 必须是一个对象，例如 { "maxAnnotations": 8 }。');
  }
  const keys = Object.keys(patch);
  if (!keys.length) throw new HttpError(400, 'patch 里没有任何设置项。');

  const normalized = {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key)) {
      throw new HttpError(400, `未知的设置项「${key}」。`);
    }
    if (key === 'novelDir') {
      /* 不能 trim：磁盘上的目录名就是权威，` 带空格 ` 这种老目录 trim 之后会变成"不存在"。 */
      if (typeof patch[key] !== 'string') throw new HttpError(400, 'novelDir 必须是字符串。');
      normalized.novelDir = patch[key];
      continue;
    }
    normalized[key] = validateSettingValue(key, patch[key]);
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'novelDir')) {
    normalized.novelDir = assertNovelDirExists(normalized.novelDir);
  }

  const next = { ...readSettingsFile(), ...normalized };
  if (Object.prototype.hasOwnProperty.call(normalized, 'novelDir')) {
    for (const legacy of LEGACY_NOVEL_KEYS) delete next[legacy];
  }
  await writeJson(file, next);
  return readSettings();
}

/**
 * 删除若干设置键（用于「回收站清空后没有任何书」时把 novelDir 清掉）。
 * @param {string[]} keys
 */
export async function removeSettingsKeys(keys) {
  const file = settingsFile();
  return withPathLock(`settings:${file}`, () => removeSettingsKeysUnlocked(keys, file));
}

async function removeSettingsKeysUnlocked(keys, file) {
  const current = readSettingsFile();
  let changed = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      delete current[key];
      changed = true;
    }
  }
  if (changed) await writeJson(file, current);
  return readSettings();
}

