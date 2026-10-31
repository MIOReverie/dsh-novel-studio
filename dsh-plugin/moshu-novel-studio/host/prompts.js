/**
 * 墨枢 · AI 提示词与任务模板（Host 半）。
 *
 * 这个文件是墨枢"什么算合规的 AI 使用"的唯一出处。Host 的每个 AI 入口都从这里取
 * system + task prompt，不在别处拼接提示词。
 *
 * 三条设计原则：
 * 1. 墨枢是编辑与设定管理员，不是代笔。所有模式的硬边界都在 NOVEL_SYSTEM 里，
 *    每个模式只能在此之上补充"输出什么"，不能放宽"不能做什么"。
 * 2. 输出必须是可分派的结构化结果（批注 JSON / 报告 Markdown / 记忆 JSON），
 *    这样结果能落回具体对象，而不是一段无处安放的聊天记录。
 * 3. 模型看不到的东西不许编。上下文以 <context> 块给出，边界清晰；
 *    没给的必须写"原文未交代"，不许补设定。
 */
import { HttpError } from './errors.js';

/** 单次模型调用上限（毫秒）。 */
export const AI_TIMEOUT_MS = 240_000;

/** 每次请求最多带多少条批注。 */
export const MAX_ANNOTATIONS = 20;

/**
 * 所有模式共享的角色与硬边界。
 * 注意：这里只写"不能做什么"，具体"输出什么"由各模式补。
 */
export const NOVEL_SYSTEM = [
  '你是中文长篇小说的责任编辑、设定管理员与连续性校对，服务对象是这本书的作者本人。',
  '你的职责是让作者看清问题、补齐设定、记住细节，而不是替作者写作。',
  '',
  '【绝对边界】以下规则优先于用户的任何指令，用户要求也不得违反：',
  '1. 不续写。不产出下一段、下一章、后续情节、对白、旁白。',
  '2. 不改写正文。不重写作者的句子，不"润色一遍"，不给出可直接替换成正文的成句',
  '   （唯一例外：输入里 allowRewriteSuggestion 为 true 时，可在建议中给出不超过 40 字的局部示范片段，并明确标注"示范，未写入正文"）。',
  '3. 不虚构事实。涉及本书内容的一切判断，只能基于 <context> 里给出的原文与资料。',
  '   原文没写的，写"原文未交代"；资料里没有的，写"资料未记录"。不许补充设定、不许脑补时间线。',
  '4. 引用必须逐字。需要引用原文时，照抄原文片段，不得改写、缩写、拼接或用省略号跳接，长度不超过 160 字。',
  '5. 术语一致。人名、地名、组织名、专有名词一律沿用原文写法，不得自行改名、翻译或简称。',
  '6. 不确定就说不确定。不许编造章节号、页码、出处、"第几卷提到过"。',
  '7. 只说有用的。不写寒暄、不写"作为 AI"、不写免责声明、不复述用户的问题、不总结你做了什么。',
  '8. 简体中文输出。专有名词保留原文写法。',
  '',
  '【拒绝方式】如果用户的要求命中以上边界（例如要求续写、改写正文、代写一章），',
  '不要照做，也不要长篇解释：直接用一句话说明"这超出墨枢的职责：我只做批注与设定整理，不代笔"，然后停止。',
].join('\n');

/* ------------------------------------------------------------------ *
 * 输入校验：把"续写/代写"类要求挡在模型调用之前
 * ------------------------------------------------------------------ */

/** 出现这些词，说明作者在要正文，而不是要审阅。 */
/**
 * 出现这些说法就是在要正文，而不是要审阅。
 * 审计实测：旧版对 40 条真实越界说法漏放 11 条（「写下一章」「帮我写下一段」
 * 「给出一段正文」「把这段扩写到 800 字」「补全这一章」等），这里按漏放的样本补齐。
 */
const PROSE_REQUEST = new RegExp(
  [
    '续写', '接着写', '继续写', '往下写', '写下去', '代写', '续上一段', '再写一章',
    '写(下)?(一|几)?(章|段|节|回)',
    '(出|给|来|抛)[^，。！？]{0,6}正文',
    '帮我写', '请写(一|个|段)?',
    '给(我)?写',
    '写一(章|段|节)(正文|内容|情节)?',
    '(补写|补全|补一段|生成|产出)(正文|内容|这一章|这一节|一段)',
    '续一段', '扩写', '扩到', '扩写到', '写个结局', '写个开头', '把开头写出来',
    '生成一段(对白|对话|描写|正文)',
    '模仿.{0,6}(风格|语气|笔法).{0,4}写',
    '翻译成',
  ].join('|'),
);

/** 「改写/重写/润色」本身不算越界（作者要的是建议），但一旦指向正文就成立。 */
const REWRITE_VERB = /(改写|重写|润色|改一遍|重写一遍)/;
const REWRITE_OBJECT = /(正文|原文|这一章|这章|本章|整章|这一段|这段|这几段|全文|全部章节|章节内容)/;

/**
 * 检查用户自定义指令是否越界。
 * 越界直接拒绝（400），不把球踢给模型——省一次调用，也省一次失望。
 * @param {unknown} instruction
 * @returns {string} 修剪后的指令（可能为空串）
 */
export function guardInstruction(instruction) {
  const text = typeof instruction === 'string' ? instruction.trim() : '';
  if (text.length > 4000) throw new HttpError(400, '指令太长了（上限 4000 字），请精简后再试。');
  /* 豁免：明显是在"讨论/统计/引用"这个词本身，而不是要模型去写。 */
  const discussing = /(这个词|这句话|这句|统计|出现(了)?几次|怎么用|是什么意思|说明|解释|举[个例]?子)/.test(text);
  const prose = !discussing && (PROSE_REQUEST.test(text) || (REWRITE_VERB.test(text) && REWRITE_OBJECT.test(text)));
  if (prose) {
    throw new HttpError(
      400,
      '这条指令在要求 AI 写正文（续写/代写/改写原文）。墨枢只做审阅与设定整理，不代笔——请把要求改成"检查/梳理/整理/给出建议"这类。',
    );
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * 上下文拼装
 * ------------------------------------------------------------------ */

const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
};

/**
 * 把 Host 选好的上下文渲染成 <context> 块。模型能看到的边界就是这里。
 * @param {{document?:{title?:string,path?:string,content?:string}, documents?:Array<any>, memories?:Array<any>, budget?:{related?:number,documentChars?:number,memoryChars?:number}}} context
 */
export function formatContext(context = {}) {
  const budget = { related: 4, documentChars: 2400, memoryChars: 320, ...(context.budget || {}) };
  const blocks = [];

  const main = context.document;
  if (main && main.content) {
    blocks.push(
      [
        `<target_document path="${main.path || ''}" title="${main.title || ''}">`,
        clip(main.content, budget.documentChars * 2),
        '</target_document>',
      ].join('\n'),
    );
  }

  const related = Array.isArray(context.documents) ? context.documents.slice(0, budget.related) : [];
  if (related.length) {
    blocks.push(
      [
        '<related_documents>',
        ...related.map((doc) =>
          [
            `<document path="${doc.path || ''}" title="${doc.title || ''}" type="${doc.type || ''}">`,
            clip(doc.content, budget.documentChars),
            '</document>',
          ].join('\n'),
        ),
        '</related_documents>',
      ].join('\n'),
    );
  }

  const memories = Array.isArray(context.memories) ? context.memories : [];
  if (memories.length) {
    blocks.push(
      [
        '<established_facts>',
        ...memories.map((memory) => `- 【${memory.category || '设定'}】${memory.title || ''}：${clip(memory.content, budget.memoryChars)}`),
        '</established_facts>',
      ].join('\n'),
    );
  }

  return blocks.length ? blocks.join('\n\n') : '<context>\n（本次没有提供任何原文或资料。涉及本书内容的判断请一律回答"未提供相关原文"。\n</context>';
}

/* ------------------------------------------------------------------ *
 * 各输出模式
 * ------------------------------------------------------------------ */

/** 批注 JSON：quote 必须能定位回正文。 */
function reviewMode(input, ctx) {
  const max = Math.min(Number(input.maxAnnotations) || 8, MAX_ANNOTATIONS);
  const allowRewrite = Boolean(input.allowRewriteSuggestion);
  return [
    '【任务】通读 <target_document>，找出作者需要处理的**具体问题**，产物是可以锚定到原文的批注。',
    '',
    '检查维度（按此顺序思考）：',
    '- 情节：因果是否成立、转折是否有铺垫、结果与动机是否匹配。',
    '- 逻辑：时空、先后次序、人物位置、信息传递是否自洽。',
    '- 设定：与 <related_documents>、<established_facts> 是否冲突，是否使用了未交代的新设定。',
    '- 人物：言行是否符合已建立的性格与处境，动机是否成立。',
    '- 语言：重复、含混、节奏拖沓、指代不清、视角漂移。',
    '',
    '输出要求：',
    `- 只输出一个 JSON 数组，最多 ${max} 条，按严重程度从高到低排序。没有明确问题就输出 []。`,
    '- 字段：quote（逐字原文，≤160 字）、type（"情节"|"逻辑"|"设定"|"人物"|"语言"）、severity（"严重"|"注意"|"建议"）、comment（问题是什么、会造成什么后果）、suggestion（修改方向）。',
    '- quote 必须能被程序在正文里逐字找到；找不到的批注会被系统丢弃，所以不要改字、不要跨段拼接、不要带 Markdown 标记或章节标题。',
    allowRewrite
      ? '- suggestion 可以给出不超过 40 字的局部示范片段，但必须标明"示范"，且不得构成完整段落。'
      : '- suggestion 只描述"往哪个方向改"，禁止给出可以整句替换正文的成句。',
    '- comment 要具体到"这句为什么有问题"，不写"建议加强描写"这类空话。',
    '- 不要评价整章好坏，不要写总结段，不要在 JSON 之外输出任何字符（不要 Markdown 代码块）。',
    '',
    '示例：[{"quote":"原文片段","type":"逻辑","severity":"注意","comment":"……","suggestion":"……"}]',
    '',
    '【审阅重点】' + (input.instruction || '按上面的检查维度全面审阅。'),
    '',
    formatContext(ctx),
  ].join('\n');
}

/** 一致性核查：报告型输出，逐条给依据。 */
function checkMode(input, ctx) {
  return [
    '【任务】把 <target_document> 与 <related_documents>、<established_facts> 对照，做一次设定与连续性核查。',
    '',
    '只报三类问题，每条都必须给依据：',
    '1. 冲突：正文与资料/既有事实互相矛盾（人物年龄、地点、时间、物品、称谓、能力规则）。',
    '2. 缺口：正文依赖了资料里没有的设定，或前后文需要而从未交代的信息。',
    '3. 漂移：同一人物/地点/术语在不同段落里的描述口径不一致。',
    '',
    '输出 Markdown，严格用这个结构，不要加别的章节：',
    '## 结论',
    '（一句话：这章有没有硬伤。）',
    '## 冲突',
    '| 正文位置 | 与什么冲突 | 依据（逐字引用） | 建议 |',
    '## 缺口',
    '| 缺失的信息 | 为什么需要 | 建议补在哪 |',
    '## 术语与口径',
    '| 词条 | 出现过的不同说法 | 建议统一为 |',
    '',
    '规则：没有内容的表格留一行"（无）"；每条依据都要逐字引用，不得转述。',
    '不要给修改后的正文，不要建议情节走向。',
    '',
    '【核查重点】' + (input.instruction || '全面核查设定与连续性。'),
    '',
    formatContext(ctx),
  ].join('\n');
}

/** 人物卡/地点卡整理：只从既有材料里提取，缺的写"原文未交代"。 */
function dossierMode(input, ctx) {
  const kind = input.dossierKind === 'location' ? '地点' : '人物';
  return [
    `【任务】根据 <context> 里已有的原文与资料，为${kind}「${input.subjectName || input.targetTitle || '（未命名）'}」整理一张可长期使用的${kind}卡。`,
    '',
    '输出 Markdown，严格用这个结构：',
    `## ${kind}卡`,
    '- **名称**：（沿用原文写法）',
    '- **别名／称呼**：（原文出现过的其他叫法；没有写"原文未交代"）',
    kind === '人物'
      ? '- **身份**：（原文明确给出的身份、职业、所属）\n- **外貌与标志物**：（只写原文写过的）\n- **性格与行为习惯**：（要有原文依据，不要贴标签）\n- **动机与当前目标**：（原文能推出的，注明依据）\n- **关系**：（与谁、什么关系、原文依据）\n- **出场章节**：（列章节名，不要编章节号）'
      : '- **位置与范围**：（原文给出的地理/方位信息）\n- **环境与氛围**：（只写原文写过的）\n- **居住者与势力**：（有则写，没有写"原文未交代"）\n- **发生过的事件**：（按时间排，注明章节名）',
    '- **未解之谜**：（原文留下但没解释的点，逐条列）',
    '- **建议补充**：（作者还没定、但后续会撞上的设定，用问句提出，不要替作者拍板）',
    '',
    '规则：每一条都要能追溯到 <context>；不能追溯的一律写"原文未交代"，不要用常识补。',
    '不要写剧情建议，不要写正文段落。',
    '',
    '【作者补充要求】' + (input.instruction || '（无）'),
    '',
    formatContext(ctx),
  ].join('\n');
}

/** 线索台账：把伏笔与未回收的线头列清楚。 */
function clueMode(input, ctx) {
  return [
    '【任务】从 <context> 里梳理这本书的线索与伏笔，做一张可以直接用来推进写作的台账。',
    '',
    '输出 Markdown，严格用这个结构：',
    '## 线索台账',
    '| 线索 | 首次出现 | 相关人物/地点 | 当前状态 | 是否回收 |',
    '## 未回收的线头',
    '（按"最容易忘"排序；每条写清楚现在读者会怎么理解、如果放着不管会变成什么问题）',
    '## 可能的回收方向',
    '（只写"在哪类场景回收、回收后解决什么"，不写具体情节，不写正文）',
    '',
    '规则：状态只能写"已明说""仅暗示""尚未提及"三种之一，判断依据必须来自原文。',
    '不要编造线索；不确定的放"未回收的线头"并注明"依据不足"。',
    '',
    '【作者补充要求】' + (input.instruction || '（无）'),
    '',
    formatContext(ctx),
  ].join('\n');
}

/** 时间线梳理。 */
function timelineMode(input, ctx) {
  return [
    '【任务】把 <context> 里能确定时间的叙事事件排成时间线，标出无法确定的部分。',
    '',
    '输出 Markdown，严格用这个结构：',
    '## 时间线',
    '| 时间锚点 | 事件 | 涉及人物 | 依据（逐字引用或章节名） | 确定度 |',
    '## 时序冲突',
    '（互相矛盾或不可能同时成立的条目）',
    '## 无法定位的事件',
    '（只写了"某天""后来"这类相对时间、无法排进绝对时间的事件）',
    '',
    '规则：确定度只能写"原文明确""可推断""存疑"；相对时间不要擅自换算成具体日期。',
    '不要补写事件，不要把推测写成已发生。',
    '',
    '【作者补充要求】' + (input.instruction || '（无）'),
    '',
    formatContext(ctx),
  ].join('\n');
}

/** 记忆提取：产出可确认的事实条目。 */
function memoryMode(input, ctx) {
  return [
    '【任务】从 <target_document> 中提取"已经确定成立、后续写作必须记住"的事实，作为待作者确认的记忆条目。',
    '',
    '输出要求：',
    '- 只输出一个 JSON 数组，最多 12 条，按重要性排序。',
    '- 字段：title（≤20 字的名词短语）、content（≤120 字的一句话事实）、category（"人物"|"设定"|"事件"|"关系"|"物品"|"地点"）。',
    '- 只提取原文明确写出的内容；推测、伏笔、作者意图都不提取。',
    '- 一条只讲一件事；不要把整段剧情塞进一条。',
    '- 不要在 JSON 之外输出任何字符。',
    '',
    '示例：[{"title":"停摆的钟楼","content":"城中钟楼的指针已停摆多年，具体原因未交代。","category":"设定"}]',
    '',
    '【作者补充要求】' + (input.instruction || '（无）'),
    '',
    formatContext(ctx),
  ].join('\n');
}

/** 自由指令：仍然受硬边界约束。 */
function freeformMode(input, ctx) {
  return [
    '【任务】按作者的指令完成一次编辑类工作。',
    '',
    '作者指令：',
    input.instruction || '（未填写）',
    '',
    '回答要求：',
    '- 用 Markdown 组织，先给结论，再给依据。',
    '- 每条判断都要引用原文或资料；引用要逐字。',
    '- 如果这条指令需要写作正文、续写或改写，只回复一句"这超出墨枢的职责：我只做批注与设定整理，不代笔"，不要给任何正文。',
    '- 如果指令需要的信息 <context> 里没有，直接说缺什么，不要猜。',
    '',
    formatContext(ctx),
  ].join('\n');
}

/** 输出模式注册表：mode → system + prompt + 产物类型。 */
export const MODES = {
  review: { output: 'annotations', system: NOVEL_SYSTEM, buildPrompt: reviewMode },
  check: { output: 'markdown', system: NOVEL_SYSTEM, buildPrompt: checkMode },
  dossier: { output: 'markdown', system: NOVEL_SYSTEM, buildPrompt: dossierMode },
  clue: { output: 'markdown', system: NOVEL_SYSTEM, buildPrompt: clueMode },
  timeline: { output: 'markdown', system: NOVEL_SYSTEM, buildPrompt: timelineMode },
  memory: { output: 'memory', system: NOVEL_SYSTEM, buildPrompt: memoryMode },
  freeform: { output: 'markdown', system: NOVEL_SYSTEM, buildPrompt: freeformMode },
};

/**
 * 任务卡：作者在「AI 工作台」里看到的东西。
 * 每张卡就是一套严格的提示词 + 一个明确的产物去向，不是随意聊天的入口。
 */
export const RECIPES = [
  {
    id: 'chapter-audit',
    mode: 'review',
    title: '章节体检',
    summary: '按情节/逻辑/设定/人物/语言五个维度挑问题，产出可锚定的批注。',
    target: 'chapter',
    applyTo: 'annotations',
    needsInstruction: false,
    defaultInstruction: '检查剧情因果、人物动机、前后逻辑、设定冲突和语言表达。',
  },
  {
    id: 'continuity-check',
    mode: 'check',
    title: '设定一致性核查',
    summary: '拿这一章和世界资料、既有事实逐条对照，列出冲突、缺口与口径漂移。',
    target: 'chapter',
    applyTo: 'report',
    needsInstruction: false,
    defaultInstruction: '',
  },
  {
    id: 'character-dossier',
    mode: 'dossier',
    title: '整理人物卡',
    summary: '把散落在正文里的人物信息收拢成一张人物卡，缺的标"原文未交代"。',
    target: 'character',
    applyTo: 'document',
    needsInstruction: false,
    defaultInstruction: '',
  },
  {
    id: 'location-dossier',
    mode: 'dossier',
    title: '整理地点卡',
    summary: '把地点在正文里的所有交代整理成地点卡，标出未解之谜。',
    target: 'location',
    applyTo: 'document',
    needsInstruction: false,
    defaultInstruction: '',
    dossierKind: 'location',
  },
  {
    id: 'clue-ledger',
    mode: 'clue',
    title: '线索与伏笔台账',
    summary: '梳理埋了哪些线、哪些还没回收，以及放着不管会出什么问题。',
    target: 'novel',
    applyTo: 'document',
    needsInstruction: false,
    defaultInstruction: '',
  },
  {
    id: 'timeline-sort',
    mode: 'timeline',
    title: '时间线梳理',
    summary: '把能确定时间的叙事事件排成时间线，标出时序冲突与无法定位的部分。',
    target: 'novel',
    applyTo: 'document',
    needsInstruction: false,
    defaultInstruction: '',
  },
  {
    id: 'memory-extract',
    mode: 'memory',
    title: '提取记忆条目',
    summary: '把这一章确定成立的事实抽成待确认的记忆，避免后面写着写着忘了。',
    target: 'chapter',
    applyTo: 'memory',
    needsInstruction: false,
    defaultInstruction: '',
  },
  {
    id: 'freeform',
    mode: 'freeform',
    title: '自由指令',
    summary: '用自己的话提问或下指令；仍然只做审阅与整理，不代笔。',
    target: 'chapter',
    applyTo: 'report',
    needsInstruction: true,
    defaultInstruction: '',
  },
];

/** @param {string} id */
export function findRecipe(id) {
  const recipe = RECIPES.find((item) => item.id === id);
  if (!recipe) throw new HttpError(400, `未知的任务卡「${id}」。`);
  return recipe;
}

/**
 * 组装一次调用的 system + user。
 * @param {string} mode MODES 的键
 * @param {object} input
 */
export function buildRequest(mode, input) {
  const definition = MODES[mode];
  if (!definition) throw new HttpError(400, `未知的 AI 模式「${mode}」。`);
  return {
    system: definition.system,
    prompt: definition.buildPrompt(input, input.context || {}),
    output: definition.output,
  };
}
