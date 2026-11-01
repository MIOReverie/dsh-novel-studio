'use strict';

/**
 * 墨枢 · 设置页。
 *
 * 一切以 CONTRACT-v2.md 的设置表为准：字段名、默认值、范围都在那边的表里，
 * 这里的 `FALLBACK_*` 只是 meta 没给时（宿主旧版本 / 渲染冒烟）的兜底，
 * 真正的范围优先用 meta.ranges，保存前一律按范围校验，越界不提交。
 *
 * 保存策略：所有改动统一走"防抖 400ms 自动保存"（不额外放保存按钮），
 * 状态在页脚如实显示：待保存 / 正在保存 / 已保存 / 失败原因。
 */

const React = require('react');
const api = require('../api');
const { useEffect, useRef, useState } = React;

const strings = require('../strings');
const css = require('./studio.css');
const {
  BrainCircuit,
  CheckCircle2,
  CircleHelp,
  FileText,
  LoaderCircle,
  PenLine,
  Save,
  Settings2,
  X,
} = require('../icons');

const t = strings.t;

/** 设置表默认值（CONTRACT-v2.md）。 */
const FALLBACK_DEFAULTS = {
  provider: '',
  model: '',
  novelDir: '',
  reviewFocus: '检查剧情因果、人物动机、前后逻辑、设定冲突和语言表达。',
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

/** 设置表范围（CONTRACT-v2.md）。 */
const FALLBACK_RANGES = {
  reviewFocus: { min: 0, max: 300, maxLength: 300 },
  maxAnnotations: { min: 1, max: 20 },
  autosaveDelayMs: { min: 600, max: 6000 },
  backupKeep: { min: 0, max: 200 },
  editorFontSize: { min: 13, max: 22 },
  contextRelatedDocs: { min: 0, max: 8 },
  contextMemories: { min: 0, max: 30 },
};

/** 恢复默认值时**不动**的三个字段：它们是"这本书的安装信息"，不是偏好。 */
const NOT_RESTORED = ['provider', 'model', 'novelDir'];

/** 数值字段 → 中文名，用于错误提示。 */
const LABELS = {
  reviewFocus: '审阅重点',
  maxAnnotations: '单次批注上限',
  allowRewriteSuggestion: '允许改写示范片段',
  autosaveDelayMs: '自动保存延迟',
  backupKeep: '备份保留份数',
  editorFontSize: '正文字号',
  editorSerif: '衬线正文',
  lineNumbers: '显示行号',
  contextRelatedDocs: '相关资料条数',
  contextMemories: '记忆条数',
  language: '语言',
  exportFormat: '导出格式',
};

function messageOf(reason, fallback) {
  if (reason && typeof reason.message === 'string' && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return fallback;
}

function mergeSettings(settings, defaults) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const base = defaults && typeof defaults === 'object' ? defaults : FALLBACK_DEFAULTS;
  return Object.assign({}, FALLBACK_DEFAULTS, base, source);
}

/**
 * 读一个字段的范围。meta.ranges 的形状契约里没写死，这里兼容
 * `{min,max}` / `[min,max]` / `maxLength` / 纯数字四种写法。
 */
function rangeFor(meta, key) {
  const table = (meta && meta.ranges) || {};
  const raw = table[key];
  const fallback = FALLBACK_RANGES[key] || { min: 0, max: 0 };
  if (raw === undefined || raw === null) return fallback;
  if (Array.isArray(raw)) {
    const min = Number(raw[0]);
    const max = Number(raw[1]);
    return {
      min: Number.isFinite(min) ? min : fallback.min,
      max: Number.isFinite(max) ? max : fallback.max,
      maxLength: Number.isFinite(max) ? max : fallback.maxLength,
    };
  }
  if (typeof raw === 'object') {
    const min = raw.min === undefined ? fallback.min : Number(raw.min);
    const max = raw.max === undefined ? fallback.max : Number(raw.max);
    const maxLength = raw.maxLength === undefined ? max : Number(raw.maxLength);
    return {
      min: Number.isFinite(min) ? min : fallback.min,
      max: Number.isFinite(max) ? max : fallback.max,
      maxLength: Number.isFinite(maxLength) ? maxLength : fallback.maxLength,
    };
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { min: fallback.min, max: raw, maxLength: raw };
  }
  return fallback;
}

function clampNumber(value, range) {
  const num = Number(value);
  if (!Number.isFinite(num)) return range.min;
  return Math.max(range.min, Math.min(range.max, Math.round(num)));
}

function SettingsView(props) {
  const settings = props.settings || {};
  const meta = props.meta || {};
  const models = props.models || {};
  const notify = typeof props.notify === 'function' ? props.notify : function () {};
  const onSave = typeof props.onSave === 'function' ? props.onSave : null;
  const onModelSelect = typeof props.onModelSelect === 'function' ? props.onModelSelect : null;

  const defaults = Object.assign({}, FALLBACK_DEFAULTS, meta.defaults || {});
  const editableKeys = Array.isArray(meta.editable) ? meta.editable : null;

  async function saveStorage(nextDir) {
    if (storageBusy) return;
    setStorageBusy(true);
    setStorageError('');
    try {
      const info = await api.request('/storage', {
        method: 'POST',
        body: JSON.stringify({ projectDir: nextDir }),
      });
      if (info) {
        setStorage(info);
        setStorageInput(info.projectDir || '');
        notify(t('数据目录已改为 {dir}', { dir: info.projectDir }));
      }
    } catch (error) {
      setStorageError(error && error.message ? error.message : String(error));
    } finally {
      setStorageBusy(false);
    }
  }

  function isEditable(key) {
    if (!editableKeys) return true;
    return editableKeys.indexOf(key) !== -1;
  }

  const [draft, setDraft] = useState(function () { return mergeSettings(settings, defaults); });
  const [saveState, setSaveState] = useState({ status: 'idle', message: '' });
  const [confirmReset, setConfirmReset] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  /* 数据目录：自定义小说存放位置（全局，不属于某个会话的 settings） */
  const [storage, setStorage] = useState(null);
  const [storageInput, setStorageInput] = useState('');
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState('');

  const pendingRef = useRef({});
  const retryRef = useRef(0);
  const timerRef = useRef(0);
  const savedSnapshotRef = useRef(JSON.stringify(mergeSettings(settings, defaults)));

  /* 数据目录：进页面拉一次，保存后刷新。 */
  useEffect(function () {
    let alive = true;
    api.request('/storage').then(function (info) {
      if (!alive || !info) return;
      setStorage(info);
      setStorageInput(info.projectDir || '');
    }).catch(function () { /* 老后端没有这个接口就不显示 */ });
    return function () { alive = false; };
  }, []);

  /* 宿主侧改动（切书、外部改设置）回流到表单：只有本地没有待保存内容时才覆盖。 */
  useEffect(function () {
    if (Object.keys(pendingRef.current).length) return;
    if (saveState.status === 'saving') return;
    const next = mergeSettings(settings, defaults);
    const json = JSON.stringify(next);
    if (json === savedSnapshotRef.current) return;
    savedSnapshotRef.current = json;
    setDraft(next);
  }, [settings]);

  /* 卸载时把还没写出去的那一批补发一次，别让最后的改动悄悄丢掉。 */
  useEffect(function () {
    return function () {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      const patch = pendingRef.current;
      pendingRef.current = {};
      if (!Object.keys(patch).length || !onSave) return;
      try { void onSave(patch); } catch (error) { /* 卸载中不再打扰作者 */ }
    };
  }, []);

  function validatePatch(patch) {
    const keys = Object.keys(patch);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = patch[key];
      const range = rangeFor(meta, key);
      if (key === 'reviewFocus') {
        if (typeof value !== 'string') return t('审阅重点必须是文本。');
        const limit = range.maxLength || 300;
        if (value.length > limit) return t('审阅重点不能超过 {n} 字。', { n: limit });
      } else if (key === 'language') {
        if (['zh', 'en'].indexOf(value) === -1) return t('语言只能是 zh 或 en。');
      } else if (key === 'exportFormat') {
        if (['md', 'txt'].indexOf(value) === -1) return t('导出格式只能是 md 或 txt。');
      } else if (key === 'provider' || key === 'model' || key === 'novelDir') {
        if (typeof value !== 'string') return t('{name} 必须是文本。', { name: key });
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) return t('{name} 必须是数字。', { name: LABELS[key] || key });
        if (value < range.min || value > range.max) {
          return t('{name} 必须在 {min}–{max} 之间。', { name: LABELS[key] || key, min: range.min, max: range.max });
        }
      }
    }
    return '';
  }

  async function flush() {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
    }
    const patch = pendingRef.current;
    pendingRef.current = {};
    if (!Object.keys(patch).length) return;
    const problem = validatePatch(patch);
    if (problem) {
      /* 非法值：把补丁丢掉是**有意的**（值本身不合法，重试也不会成功），
         但要把 draft 拉回磁盘值，否则开关停在一个永远不会生效的位置上。 */
      setSaveState({ status: 'error', message: problem });
      setDraft(Object.assign({}, mergeSettings(settings, defaults)));
      return;
    }
    if (!onSave) {
      setSaveState({ status: 'error', message: t('宿主没有提供保存设置的入口。') });
      return;
    }
    setSaveState({ status: 'saving', message: '' });
    try {
      const result = await onSave(patch);
      if (result === false) throw new Error(t('设置没有保存成功，宿主拒绝了这次修改'));
      savedSnapshotRef.current = JSON.stringify(Object.assign({}, mergeSettings(settings, defaults), patch));
      retryRef.current = 0;
      setSaveState({ status: 'saved', message: t('已保存') });
    } catch (reason) {
      /* 失败时把补丁放回队列：以前直接丢掉，界面显示新值、磁盘还是旧值，
         而且再也不会重试。 */
      pendingRef.current = Object.assign({}, patch, pendingRef.current);
      setSaveState({ status: 'error', message: messageOf(reason, t('设置保存失败')) });
      /* 退避重试：400ms → 1.6s → 6s → 放弃（避免磁盘只读时无限打转）。 */
      const attempt = (retryRef.current || 0) + 1;
      retryRef.current = attempt;
      if (attempt <= 3 && !timerRef.current) {
        timerRef.current = window.setTimeout(flush, 400 * Math.pow(4, attempt - 1));
      } else if (attempt > 3) {
        retryRef.current = 0;
        pendingRef.current = {};
        setDraft(Object.assign({}, mergeSettings(settings, defaults)));
      }
    } finally {
      if (Object.keys(pendingRef.current).length) {
        timerRef.current = window.setTimeout(flush, 400);
      }
    }
  }

  function queueChange(key, value) {
    if (!isEditable(key)) return;
    setDraft(function (prev) {
      const next = Object.assign({}, prev);
      next[key] = value;
      return next;
    });
    pendingRef.current = Object.assign({}, pendingRef.current, { [key]: value });
    setSaveState({ status: 'pending', message: '' });
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, 400);
  }

  function restoreDefaults() {
    setConfirmReset(false);
    const patch = {};
    Object.keys(defaults).forEach(function (key) {
      if (NOT_RESTORED.indexOf(key) !== -1) return;
      if (!isEditable(key)) return;
      if (defaults[key] === undefined) return;
      patch[key] = defaults[key];
    });
    if (!Object.keys(patch).length) return;
    setDraft(function (prev) { return Object.assign({}, prev, patch); });
    pendingRef.current = Object.assign({}, pendingRef.current, patch);
    setSaveState({ status: 'pending', message: '' });
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, 400);
    notify(t('已回到默认值，正在保存'));
  }

  /* ---------------- 模型 ---------------- */

  const currentModel = models.current && typeof models.current === 'object'
    ? models.current
    : { provider: draft.provider, model: draft.model };
  const providers = Array.isArray(models.providers) ? models.providers : [];
  const currentLabel = currentModel.provider && currentModel.model
    ? currentModel.provider + ' / ' + currentModel.model
    : (currentModel.model || currentModel.provider || t('未设置'));

  const modelPairs = [];
  providers.forEach(function (provider) {
    const list = Array.isArray(provider && provider.models) ? provider.models : [];
    list.forEach(function (model) {
      if (!model || !model.id) return;
      modelPairs.push({
        value: String(provider.id) + ':' + String(model.id),
        provider: String(provider.id),
        providerName: String(provider.name || provider.id),
        model: String(model.id),
        modelName: String(model.name || model.id),
      });
    });
  });
  const currentValue = currentModel.provider && currentModel.model
    ? String(currentModel.provider) + ':' + String(currentModel.model)
    : '';
  const currentInList = modelPairs.some(function (pair) { return pair.value === currentValue; });

  async function changeModel(event) {
    const value = String(event.target.value || '');
    const at = value.indexOf(':');
    if (at < 0) return;
    const provider = value.slice(0, at);
    const model = value.slice(at + 1);
    if (!onModelSelect) {
      setSaveState({ status: 'error', message: t('宿主没有提供切换模型的入口。') });
      return;
    }
    setModelBusy(true);
    try {
      const result = await onModelSelect(provider, model);
      if (result === false) throw new Error(t('切换模型失败，宿主没有接受这次改动'));
      notify(t('已切换模型：{name}', { name: provider + ' / ' + model }));
    } catch (reason) {
      setSaveState({ status: 'error', message: messageOf(reason, t('切换模型失败')) });
    } finally {
      setModelBusy(false);
    }
  }

  /* ---------------- 表单零件 ---------------- */

  function renderSlider(key, options) {
    const range = rangeFor(meta, key);
    const raw = Number(draft[key]);
    const value = Number.isFinite(raw) ? raw : range.min;
    const format = typeof options.format === 'function' ? options.format : function (next) { return String(next); };
    return (
      <div className="studio-row" key={key}>
        <div className="studio-row-main">
          <span className="studio-row-label">{options.label}</span>
          <span className="studio-row-help">{options.help}</span>
        </div>
        <div className="studio-slider">
          <input
            type="range"
            min={range.min}
            max={range.max}
            step={options.step || 1}
            value={value}
            disabled={!isEditable(key)}
            aria-label={options.label}
            onChange={function (event) { queueChange(key, clampNumber(event.target.value, range)); }}
          />
          <output className="studio-slider-value">{format(value)}</output>
        </div>
      </div>
    );
  }

  function renderSwitch(key, options) {
    const on = Boolean(draft[key]);
    return (
      <div className="studio-row" key={key}>
        <div className="studio-row-main">
          <span className="studio-row-label">{options.label}</span>
          <span className={options.warn ? 'studio-row-help is-warn' : 'studio-row-help'}>{options.help}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={options.label}
          className={'studio-switch' + (on ? ' is-on' : '')}
          disabled={!isEditable(key)}
          onClick={function () { queueChange(key, !on); }}
        >
          <span className="studio-switch-track"><span className="studio-switch-thumb" /></span>
          <span className="studio-switch-text">{on ? t('开') : t('关')}</span>
        </button>
      </div>
    );
  }

  function renderSegmented(key, options, hint) {
    const value = String(draft[key] || '');
    return (
      <div className="studio-row" key={key}>
        <div className="studio-row-main">
          <span className="studio-row-label">{t(LABELS[key] || key)}</span>
          {hint ? <span className="studio-row-help">{hint}</span> : null}
        </div>
        <div className="studio-segmented" role="group" aria-label={t(LABELS[key] || key)}>
          {options.map(function (option) {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                className={active ? 'is-active' : ''}
                aria-pressed={active}
                disabled={!isEditable(key)}
                onClick={function () { queueChange(key, option.value); }}
              >
                {t(option.label)}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const saveStatusText = saveState.status === 'saving'
    ? t('正在保存…')
    : saveState.status === 'saved'
      ? t('已保存')
      : saveState.status === 'pending'
        ? t('待保存（停止输入 0.4 秒后写入）')
        : saveState.status === 'error'
          ? t('保存失败：{reason}', { reason: saveState.message })
          : t('改动会自动保存（防抖 0.4 秒）');

  const autoSaveSeconds = (Number(draft.autosaveDelayMs) || FALLBACK_DEFAULTS.autosaveDelayMs) / 1000;

  return (
    <div className="studio-view studio-settings">
      <style dangerouslySetInnerHTML={{ __html: css }} />

      <header className="studio-header">
        <div>
          <div className="studio-eyebrow"><Settings2 size={14} />设置</div>
        </div>
        <div className="studio-header-meta">
          <span className="studio-model"><i />{currentLabel}</span>
          <span className="studio-header-note">{t('全部设置保存在这本书的 .moshu/settings.json')}</span>
        </div>
      </header>

      {!editableKeys && (
        <div className="studio-banner is-soft" role="status">
          <CircleHelp size={15} />
          <div>
            <p>{t('宿主没有返回可编辑字段清单（meta.editable），这里按契约全量展示；保存时仍以宿主校验为准。')}</p>
          </div>
        </div>
      )}

      {models.message && (
        <div className="studio-banner" role="status">
          <CircleHelp size={15} />
          <div>
            <strong>{t('模型列表不完整')}</strong>
            <p>{String(models.message)}</p>
          </div>
        </div>
      )}

      <div className="studio-settings-grid">
        {/* 1 模型 */}
        <section className="studio-card">
          <div className="studio-card-head">
            <div>
              <h2><BrainCircuit size={16} />{t('AI 模型')}</h2>
              <p>{t('默认跟随 DSH 会话的模型；下面只作为宿主没有默认模型时的兜底。')}</p>
            </div>
          </div>
          <div className="studio-current-model">
            <span className="studio-model is-large"><i />{currentLabel}</span>
            <span className="studio-row-help">{t('当前生效')}</span>
          </div>
          {modelPairs.length ? (
            <label className="studio-field">
              <span className="studio-label">{t('切换模型')}</span>
              <select
                className="studio-select"
                value={currentInList ? currentValue : ''}
                disabled={!onModelSelect || modelBusy}
                onChange={changeModel}
              >
                {!currentInList && <option value="">{t('当前通道不在列表里')}</option>}
                {providers.map(function (provider) {
                  const list = Array.isArray(provider && provider.models) ? provider.models : [];
                  const usable = list.filter(function (model) { return model && model.id; });
                  if (!usable.length) return null;
                  return (
                    <optgroup key={String(provider.id)} label={String(provider.name || provider.id)}>
                      {usable.map(function (model) {
                        const value = String(provider.id) + ':' + String(model.id);
                        const name = String(model.name || model.id);
                        return (
                          <option key={value} value={value}>
                            {name === String(model.id) ? name : name + '（' + String(model.id) + '）'}
                          </option>
                        );
                      })}
                    </optgroup>
                  );
                })}
              </select>
            </label>
          ) : (
            <p className="studio-empty-inline">{t('宿主没有返回可切换的模型通道。')}</p>
          )}
          {modelBusy ? <p className="studio-inline"><LoaderCircle size={14} className="is-spinning" />{t('正在切换模型…')}</p> : null}
        </section>

        {/* 2 AI 行为 */}
        <section className="studio-card">
          <div className="studio-card-head">
            <div>
              <h2><CircleHelp size={16} />{t('AI 行为')}</h2>
              <p>{t('决定 AI 看什么、写多少条批注。')}</p>
            </div>
          </div>

          <label className="studio-field">
            <span className="studio-label">{t('审阅重点')}</span>
            <textarea
              className="studio-textarea"
              rows={4}
              value={String(draft.reviewFocus || '')}
              maxLength={rangeFor(meta, 'reviewFocus').maxLength || 300}
              disabled={!isEditable('reviewFocus')}
              placeholder={t('例如：检查剧情因果、人物动机、前后逻辑、设定冲突和语言表达。')}
              onChange={function (event) { queueChange('reviewFocus', event.target.value); }}
            />
            <span className="studio-help">
              {t('{n} / {max} 字 · 作为每张审阅卡的默认要求', { n: String(draft.reviewFocus || '').length, max: rangeFor(meta, 'reviewFocus').maxLength || 300 })}
            </span>
          </label>

          {renderSlider('maxAnnotations', {
            label: t('单次批注上限'),
            help: t('一次审阅最多返回多少条批注（1–20）。'),
            format: function (value) { return t('{n} 条', { n: value }); },
          })}

          {renderSwitch('allowRewriteSuggestion', {
            label: t('允许「改写示范片段」'),
            help: t('默认关闭。即使开启，AI 也不会把任何文字写入正文：只会在批注 suggestion 里给不超过 40 字的局部示范，标注「示范，未写入正文」，仍要你手动决定怎么改。'),
            warn: true,
          })}

          {renderSlider('contextRelatedDocs', {
            label: t('相关资料条数'),
            help: t('每次任务自动附带的世界资料条数（0–8）。'),
            format: function (value) { return t('{n} 篇', { n: value }); },
          })}

          {renderSlider('contextMemories', {
            label: t('记忆条数'),
            help: t('每次任务自动附带的记忆条数，锁定记忆优先（0–30）。'),
            format: function (value) { return t('{n} 条', { n: value }); },
          })}
        </section>

        {/* 3 编辑器 */}
        <section className="studio-card">
          <div className="studio-card-head">
            <div>
              <h2><PenLine size={16} />{t('编辑器')}</h2>
              <p>{t('写作页的手感，只影响你自己的屏幕。')}</p>
            </div>
          </div>

          {renderSlider('autosaveDelayMs', {
            label: t('自动保存延迟'),
            help: t('停止输入多久之后自动保存（0.6–6 秒）。'),
            step: 100,
            format: function (value) { return t('{s} 秒', { s: autoSaveSeconds.toFixed(1) }); },
          })}

          {renderSlider('editorFontSize', {
            label: t('正文字号'),
            help: t('写作页正文的字体大小（13–22 px）。'),
            format: function (value) { return t('{n} px', { n: value }); },
          })}

          {renderSwitch('editorSerif', {
            label: t('衬线正文'),
            help: t('正文使用衬线字体（宋体一类），更接近印刷阅读。'),
          })}

          {renderSwitch('lineNumbers', {
            label: t('显示行号'),
            help: t('写作页默认显示行号，方便和批注对位置。'),
          })}
        </section>

        {/* 4 数据 */}
        <section className="studio-card">
          <div className="studio-card-head">
            <div>
              <h2><Save size={16} />{t('数据')}</h2>
              <p>{t('备份、导出与当前作品目录。')}</p>
            </div>
          </div>

          {renderSlider('backupKeep', {
            label: t('备份保留份数'),
            help: t('每份文档保留多少个历史备份；设为 0 表示不清理（会一直累积）。'),
            format: function (value) { return value === 0 ? t('0 · 不清理') : t('{n} 份', { n: value }); },
          })}

          {renderSegmented('exportFormat', [
            { value: 'md', label: 'Markdown（.md）' },
            { value: 'txt', label: '纯文本（.txt）' },
          ], t('导出整本稿件时使用的格式。'))}

          <div className="studio-row">
            <div className="studio-row-main">
              <span className="studio-row-label">{t('当前作品目录')}</span>
              <span className="studio-row-help">{t('只读 · 由宿主决定，切换书籍请用顶栏的书籍菜单')}</span>
            </div>
            <code className="studio-readonly">{String(draft.novelDir || t('（未设置）'))}</code>
          </div>

          {storage ? (
            <div className="studio-row studio-storage">
              <div className="studio-row-main">
                <span className="studio-row-label">{t('数据目录')}</span>
                <span className="studio-row-help">
                  {t('作品存放在 {root}/.moshu/novels/&lt;书名&gt;：一个工作区服务一本小说，同一个工作区的不同对话共用这批书。换目录只改位置，不会自动搬已有文件。', {
                    root: storage.projectDir,
                  })}
                </span>
              </div>
              <div className="studio-storage-edit">
                <input
                  type="text"
                  value={storageInput}
                  spellCheck={false}
                  placeholder={storage.defaultProjectDir}
                  onChange={function (event) { setStorageInput(event.target.value); }}
                  onKeyDown={function (event) { if (event.key === 'Enter') void saveStorage(storageInput.trim()); }}
                />
                <button
                  type="button"
                  className="studio-storage-save"
                  disabled={storageBusy || !storageInput.trim() || storageInput.trim() === storage.projectDir}
                  onClick={function () { void saveStorage(storageInput.trim()); }}
                >
                  {storageBusy ? t('保存中…') : t('保存')}
                </button>
                <button
                  type="button"
                  className="studio-storage-reset"
                  disabled={storageBusy || storage.isDefault}
                  title={storage.defaultProjectDir}
                  onClick={function () { void saveStorage(storage.defaultProjectDir); }}
                >
                  {t('恢复默认')}
                </button>
              </div>
              {storageError ? <p className="studio-storage-error" role="alert">{storageError}</p> : null}
            </div>
          ) : null}
        </section>

        {/* 5 语言 */}
        <section className="studio-card">
          <div className="studio-card-head">
            <div>
              <h2><FileText size={16} />{t('语言')}</h2>
              <p>{t('界面文案语言。')}</p>
            </div>
          </div>

          {renderSegmented('language', [
            { value: 'zh', label: t('简体中文') },
            { value: 'en', label: 'English' },
          ], t('保存后立即生效，界面文案马上跟着切换。'))}

          <p className="studio-help">{t('只影响界面文案，不改变正文、资料与批注内容。')}</p>
        </section>
      </div>

      <footer className="studio-settings-footer">
        <div className="studio-save-state" aria-live="polite">
          {saveState.status === 'saving' ? <LoaderCircle size={14} className="is-spinning" /> : null}
          {saveState.status === 'saved' ? <CheckCircle2 size={14} /> : null}
          {saveState.status === 'error' ? <X size={14} /> : null}
          {saveState.status === 'pending' ? <CircleHelp size={14} /> : null}
          <span className={saveState.status === 'error' ? 'is-error' : saveState.status === 'saved' ? 'is-ok' : ''}>
            {saveStatusText}
          </span>
        </div>

        <div className="studio-footer-actions">
          {confirmReset ? (
            <>
              <span className="studio-row-help">{t('会恢复除模型通道与作品目录以外的全部设置。')}</span>
              <button type="button" className="studio-btn" onClick={function () { setConfirmReset(false); }}>{t('取消')}</button>
              <button type="button" className="studio-btn is-danger" onClick={restoreDefaults}>{t('确认恢复默认值')}</button>
            </>
          ) : (
            <button type="button" className="studio-btn" onClick={function () { setConfirmReset(true); }}>{t('恢复默认值')}</button>
          )}
        </div>
      </footer>
    </div>
  );
}

module.exports = { SettingsView };
