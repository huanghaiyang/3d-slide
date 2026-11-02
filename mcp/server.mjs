#!/usr/bin/env node
/**
 * 3d-slide MCP 服务（零依赖，stdio JSON-RPC）
 *
 * 使用方式：
 *   1. 在应用内「AI 与 MCP 设置」中导出脱敏快照 workspace-snapshot.json
 *   2. 运行：SLIDE_SNAPSHOT=workspace-snapshot.json npm run mcp
 *   3. 在 MCP 客户端中注册：
 *      { "command": "node", "args": ["mcp/server.mjs"],
 *        "env": { "SLIDE_SNAPSHOT": "workspace-snapshot.json" } }
 *
 * 安全规则：快照本身不含资源文件内容与任何密钥；本服务也不会读取资源二进制，
 * 仅暴露作品结构、资源元数据与视点信息（只读）。
 * 唯一写入能力：write_plan 只把 3d-slide/plan@1 方案写入 .mcp/plans/，
 * 不修改任何作品数据；方案由用户在应用内「AI 助手 → 导入方案」确认后落地。
 *
 * 传输与协议（MCP / JSON-RPC 2.0）：
 * - 通过标准输入 / 标准输出做「按行分隔」的通讯（stdio transport）：每行一条完整的
 *   JSON-RPC 消息，不依赖 HTTP 或 WebSocket，因此可被 MCP 客户端以子进程方式直接拉起。
 * - 协议版本固定为 2024-11-05（见 PROTOCOL_VERSION）。MCP 用「能力（capabilities）」
 *   声明服务端支持的功能，本服务声明 tools 与 resources 两类。
 * - tools/list：返回工具清单（name / description / inputSchema），供客户端把工具
 *   暴露给模型；tools/call：按 name 与 arguments 执行工具，结果以 content 数组返回。
 * - resources/list 与 resources/read：以只读 URI（slide://...）提供作品、资源与方案内容。
 *
 * 与项目其他模块的关系：
 * - 快照由 src/lib/snapshot.ts 生成（导出脱敏快照，schema 为 3d-slide/workspace@1）；
 *   本服务只读取快照文件，不直接访问浏览器端的 IndexedDB 与资源二进制。
 * - 方案格式与落地逻辑与 src/lib/aiTools.ts 共用（PLAN_SCHEMA 同为 3d-slide/plan@1）；
 *   本服务只负责写文件，真正修改作品由应用内的「导入方案」执行。
 * - 启动入口：package.json 中的 `npm run mcp`（即 node mcp/server.mjs）。
 *
 * 文件结构（按常量与调用关系自上而下）：
 *   常量与路径 -> 快照读取 / 脱敏 -> 方案规范、校验与读写 -> 工具注册表 TOOLS
 *   -> 资源列表 / 读取 -> tools/call 分发 -> JSON-RPC 消息处理 -> stdin 读取循环
 */
// Node.js 内置 readline：按行读取标准输入，实现 stdio 传输的逐行解析。
import { createInterface } from 'node:readline';
// 文件系统能力：判断文件存在、建目录、读取快照 / 方案、写入方案、列目录与取文件信息。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
// 路径工具：dirname 取目录、join 拼接相对路径、resolve 转成绝对路径。
import { dirname, join, resolve } from 'node:path';
// 把 import.meta.url（文件 URL）转成系统路径，用于定位 mcp/ 目录及项目根目录。
import { fileURLToPath } from 'node:url';

/** 服务端身份信息，在 initialize 响应中返回，供客户端展示名称与版本。 */
const SERVER_INFO = { name: '3d-slide-mcp', version: '0.1.0' };
/** MCP 协议版本号，initialize 时回显给客户端，双方据此约定消息格式。 */
const PROTOCOL_VERSION = '2024-11-05';
/**
 * 敏感字段名正则（大小写不敏感）。
 * 快照本身已脱敏，这里在输出前再递归过滤一次，作为第二道保险。
 */
const SENSITIVE_KEY = /(apikey|api_key|token|secret|password|passwd|authorization|cookie|credential|privatekey)/i;

/** 本文件（mcp/server.mjs）所在目录；下面用它把相对路径折算到项目根目录。 */
const here = dirname(fileURLToPath(import.meta.url));
/**
 * 工作区快照路径：优先取环境变量 SLIDE_SNAPSHOT，
 * 否则回退到项目根目录下的 .mcp/workspace-snapshot.json。
 * 该文件由应用内「AI 助手与集成 → 导出脱敏快照」生成。
 */
const snapshotPath = resolve(
  process.env.SLIDE_SNAPSHOT || join(here, '..', '.mcp', 'workspace-snapshot.json'),
);
/**
 * 方案输出目录：write_plan 的唯一写入位置，默认 .mcp/plans/。
 * 可用环境变量 SLIDE_PLANS_DIR 覆盖，便于测试时隔离文件。
 */
const plansDir = resolve(process.env.SLIDE_PLANS_DIR || join(here, '..', '.mcp', 'plans'));

/** 创作方案的 schema 标识，必须与 src/lib/aiTools.ts 中的 PLAN_SCHEMA 保持一致。 */
const PLAN_SCHEMA = '3d-slide/plan@1';
/** 单份方案允许的最大操作步数，避免模型一次提交过大的改动。 */
const PLAN_MAX_OPERATIONS = 120;
/** 方案支持的全部原子操作名；validatePlan 据此拒绝未知的 op。 */
const PLAN_OPERATIONS = [
  'add_text',
  'add_shape',
  'add_asset',
  'update_objects',
  'delete_objects',
  'set_deck',
  'create_view',
];
/** 画面锚点枚举：add_* 操作用它定位对象，模型无需手算世界坐标。 */
const PLAN_ANCHORS = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'left-third',
  'right-third',
];

// 快照缓存：避免每次工具调用都重新读盘并解析 JSON。
// cacheKey 由「文件修改时间 : 文件大小」组成，文件变化时缓存自动失效。
let cache = null;
let cacheKey = '';

/**
 * 读取并解析工作区快照（带缓存）。
 *
 * 缓存策略：以「文件修改时间 + 文件大小」拼成缓存键，键未变化时直接返回上次的解析结果，
 * 因此重复调用工具不会产生额外 IO；用户重新导出快照后文件信息变化，缓存自动失效。
 *
 * @returns {object} schema 为 3d-slide/workspace@1 的快照对象
 * @throws {Error} 文件不存在、JSON 解析失败或 schema 不匹配时抛出中文提示
 */
function loadSnapshot() {
  // stamp 记录本次读到的文件变更信息，用于和缓存键比对。
  let stamp = '';
  try {
    const info = statSync(snapshotPath);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    throw new Error(
      `未找到工作区快照：${snapshotPath}\n请先在应用内「AI 助手与集成 → 导出脱敏快照」，再通过 SLIDE_SNAPSHOT 指定文件路径。`,
    );
  }
  if (cache && cacheKey === stamp) return cache;
  const raw = readFileSync(snapshotPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.schema !== '3d-slide/workspace@1') {
    throw new Error('快照格式不受支持，请重新导出 workspace snapshot');
  }
  cache = parsed;
  cacheKey = stamp;
  return parsed;
}

/**
 * 递归剔除敏感字段，作为输出前的最后一道脱敏。
 *
 * @param {unknown} input 任意 JSON 结构（快照片段、工具返回值等）
 * @returns {unknown} 深拷贝后的同构结构；对象的键命中 SENSITIVE_KEY 时整条丢弃
 *
 * 规则：数组逐项递归；原始值（字符串 / 数字 / 布尔 / null）原样返回。
 */
function stripSensitive(input) {
  if (Array.isArray(input)) return input.map(stripSensitive);
  if (!input || typeof input !== 'object') return input;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key)) continue;
    output[key] = stripSensitive(value);
  }
  return output;
}

/**
 * 在快照中按 id 查找作品。
 *
 * @param {object} snapshot 工作区快照
 * @param {string} deckId   作品 id
 * @returns {object|null} 找到的作品对象；未找到返回 null，由调用方抛出中文错误
 */
function findDeck(snapshot, deckId) {
  return snapshot.decks.find((deck) => deck.id === deckId) ?? null;
}

/* --------------------------- 创作方案（plan） --------------------------- */

/**
 * 每种方案操作的参数说明表。
 *
 * 该表只用于 plan_schema 工具的文档输出（给人 / 模型阅读），不参与运行时校验；
 * required 列出必填字段名，optional 是一段可选项说明字符串。
 * 真正的落地逻辑位于 src/lib/aiTools.ts，本服务只负责把规范暴露给模型。
 */
const PLAN_OP_SPECS = [
  {
    op: 'add_text',
    description: '添加文本对象',
    required: ['text'],
    optional:
      'fontSize, font(sans|serif|round|mono), align(left|center|right), bold, color(#rrggbb), lineHeight, depth3d, width, name',
  },
  {
    op: 'add_shape',
    description: '添加形状对象',
    required: ['shape'],
    optional:
      'shape: rect|roundedRect|ellipse|triangle|diamond|star|arrow|line|path; width, height, fill, stroke, strokeWidth, rotation, name',
  },
  {
    op: 'add_asset',
    description: '把资源库中的素材放到画布',
    required: ['asset'],
    optional: 'asset 为资源 id 或名称；kind, width, height, fit(contain|cover), rotation, name',
  },
  {
    op: 'update_objects',
    description: '批量修改已存在的对象',
    required: ['ids', 'patch'],
    optional:
      'patch 支持 x/y/z/width/height/rotation/rotationX/rotationY/opacity/visible/text/fontSize/font/bold/align/color/lineHeight/depth3d/fill/stroke/strokeWidth/fit/loop/volume/muted/speed/autoRotate/rotateSpeed/name',
  },
  { op: 'delete_objects', description: '删除对象', required: ['ids'], optional: '' },
  {
    op: 'set_deck',
    description: '修改作品标题、背景与播放设置',
    required: ['title 或 background/defaultDuration/showProgress 之一'],
    optional: 'title, background(#rrggbb), defaultDuration, showProgress',
  },
  {
    op: 'create_view',
    description: '创建一个展示视点（相机机位）',
    required: [],
    optional: 'target{x,y,z}, distance, yaw, pitch, name, duration',
  },
];

/**
 * 关于对象摆放的通用说明：所有 add_* 操作都可用 anchor（画面锚点）加 dx/dy（百分比微调）
 * 表达相对位置，引擎会把「画面右下」等锚点换算成世界坐标，模型无需关心坐标轴方向。
 */
const PLAN_PLACEMENT =
  '所有 add_* 操作都支持 anchor（画面锚点）与 dx/dy（百分比 -100~100 微调），无需手算世界坐标：' +
  '画面右下 = 世界 +X/+Y 的反向由引擎处理。';

/**
 * 生成 plan_schema 工具的返回值：创作方案的完整规范文档。
 *
 * 同时提供人可读的 rules / operations 说明与机器可读的 jsonSchema，
 * 并附带一份可直接照抄的示例，帮助模型在调用 write_plan 前构造合法方案。
 *
 * @returns {object} 含 schema、summary、rules、anchors、operations、jsonSchema 与 example
 */
function planSchemaDoc() {
  return {
    schema: PLAN_SCHEMA,
    summary:
      '3d-slide 创作方案：一组原子操作，用户在应用内「AI 助手 → 导入方案」确认后一次性落地到当前作品。',
    rules: [
      `plan.schema 固定为 ${PLAN_SCHEMA}`,
      `operations 数组长度 1–${PLAN_MAX_OPERATIONS}`,
      '顶层 title / background 会先于 operations 应用',
      'add_asset 的 asset 必须是资源库中真实存在的资源 id 或名称，可先用 search_assets 查询',
      'update_objects / delete_objects 的 ids 必须是当前作品中已存在的对象 id，可先用 get_deck 查询',
      PLAN_PLACEMENT,
    ],
    anchors: PLAN_ANCHORS,
    operations: PLAN_OP_SPECS,
    jsonSchema: {
      type: 'object',
      required: ['schema', 'operations'],
      properties: {
        schema: { const: PLAN_SCHEMA },
        title: { type: 'string', description: '可选：作品标题' },
        background: { type: 'string', description: '可选：作品背景色 #rrggbb' },
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: PLAN_MAX_OPERATIONS,
          items: {
            type: 'object',
            required: ['op'],
            properties: {
              op: { enum: PLAN_OPERATIONS },
              anchor: { enum: PLAN_ANCHORS },
              dx: { type: 'number', description: '水平微调百分比，-100~100' },
              dy: { type: 'number', description: '垂直微调百分比，-100~100' },
              depth: { type: 'number', description: '可选：对象在空间中的 z 深度' },
            },
            additionalProperties: true,
          },
        },
      },
      additionalProperties: false,
    },
    example: {
      schema: PLAN_SCHEMA,
      title: '新品发布 · 三屏叙事',
      background: '#06070d',
      operations: [
        {
          op: 'add_text',
          text: 'NOVA 07',
          fontSize: 120,
          bold: true,
          color: '#f5f7ff',
          anchor: 'center',
          dy: -12,
          name: '主标题',
        },
        {
          op: 'add_shape',
          shape: 'line',
          width: 620,
          height: 6,
          fill: '#4f7cff',
          anchor: 'center',
          dy: 10,
        },
        {
          op: 'add_text',
          text: '更轻，更快，更自由',
          fontSize: 42,
          color: '#9aa4c4',
          anchor: 'center',
          dy: 22,
        },
        {
          op: 'create_view',
          target: { x: 0, y: 0, z: 0 },
          distance: 620,
          name: '主画面',
          duration: 6,
        },
      ],
    },
  };
}

/**
 * 校验方案的最小合法性：只检查结构、schema、操作步数与 op 名称白名单，
 * 不校验对象 id / 资源是否真实存在（那一步由应用内导入时完成）。
 *
 * @param {unknown} plan 待校验的方案
 * @returns {object} 校验通过的同一个方案对象，便于链式使用
 * @throws {Error} 结构、schema、operations 数量或 op 名称不合法时抛出中文错误
 */
function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('plan 必须是 JSON 对象');
  if (plan.schema !== PLAN_SCHEMA) throw new Error(`plan.schema 必须是 ${PLAN_SCHEMA}`);
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) {
    throw new Error('plan.operations 不能为空');
  }
  if (plan.operations.length > PLAN_MAX_OPERATIONS) {
    throw new Error(`plan.operations 最多 ${PLAN_MAX_OPERATIONS} 步`);
  }
  plan.operations.forEach((operation, index) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error(`operations[${index}] 必须是对象`);
    }
    if (typeof operation.op !== 'string' || !operation.op) {
      throw new Error(`operations[${index}] 缺少 op`);
    }
    if (!PLAN_OPERATIONS.includes(operation.op)) {
      throw new Error(`operations[${index}] 的 op「${operation.op}」不受支持`);
    }
  });
  return plan;
}

/**
 * 把用户提供的方案名清洗成安全的文件名。
 *
 * 处理顺序：去掉 .json 后缀 -> 把路径分隔符与空白替换为连字符 -> 折叠重复连字符
 * -> 去掉首尾的 - _ . -> 截断到 60 字符，避免路径穿越与非法/过长文件名。
 *
 * @param {unknown} value 原始名称（可能是 null / undefined / 非字符串）
 * @returns {string} 清洗后的名称；没有有效内容时返回空字符串，由调用方兜底
 */
function sanitizePlanName(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw
    .replace(/\.json$/i, '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 60);
}

/**
 * write_plan 工具的处理器：校验方案并写入 .mcp/plans/。
 *
 * 这是整个服务唯一的写操作，且只写方案 JSON 文件，不触碰任何作品数据。
 * 同名文件已存在时自动追加 -2、-3 等序号（最多尝试 50 次），避免覆盖历史方案。
 *
 * @param {{plan: object, name?: string}} args 工具参数
 * @returns {{ok: boolean, path: string, relative: string, schema: string, operations: number, next: string}}
 *          写入结果：绝对路径、项目内相对路径、schema、操作步数，以及导入提示
 * @throws {Error} 方案不合法、同名方案过多或写入失败时抛出
 */
function writePlan(args) {
  const plan = validatePlan(args.plan);
  // 文件名优先级：显式 name > 方案 title > 时间戳，保证总能得到一个名字。
  const base = sanitizePlanName(args.name) || sanitizePlanName(plan.title) || `plan-${Date.now()}`;
  // 目录可能尚未创建（首次写方案），递归创建是幂等的。
  mkdirSync(plansDir, { recursive: true });
  let filename = `${base}.json`;
  for (let index = 2; existsSync(join(plansDir, filename)); index += 1) {
    if (index > 50) throw new Error('同名方案过多，请换一个 name');
    filename = `${base}-${index}.json`;
  }
  writeFileSync(join(plansDir, filename), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    path: join(plansDir, filename),
    relative: `.mcp/plans/${filename}`,
    schema: plan.schema,
    operations: plan.operations.length,
    next: '在应用内打开目标作品 → AI 助手 → 导入方案，选择该文件即可自动落地（可撤销）。',
  };
}

/**
 * 列出方案目录下的 .json 文件，按更新时间倒序（最新的在前）。
 *
 * @returns {Array<{name: string, path: string, size: number, updatedAt: number}>}
 *          目录不存在（从未写过方案）时返回空数组；path 为项目内展示路径
 */
function listPlanFiles() {
  // 首次使用时目录还不存在，返回空列表而不是抛错。
  if (!existsSync(plansDir)) return [];
  return readdirSync(plansDir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => {
      const info = statSync(join(plansDir, name));
      return { name, path: `.mcp/plans/${name}`, size: info.size, updatedAt: info.mtimeMs };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/**
 * 读取单个方案文件的内容。
 *
 * 安全处理：先剥离名称中的所有斜杠，阻止 ../ 之类的路径穿越；再要求以 .json 结尾，
 * 从而只允许访问 plansDir 下的方案文件。
 *
 * @param {unknown} name 方案文件名（可带 .json 后缀）
 * @returns {object} 解析后的方案 JSON
 * @throws {Error} 名称非法、文件不存在或 JSON 解析失败时抛出
 */
function readPlanFile(name) {
  // 去掉全部斜杠，避免通过 ../ 跳出 plansDir。
  const safe = String(name ?? '').replace(/[\\/]+/g, '');
  if (!safe.toLowerCase().endsWith('.json')) throw new Error('方案文件名必须以 .json 结尾');
  const full = join(plansDir, safe);
  if (!existsSync(full)) throw new Error(`未找到方案文件：${safe}`);
  return JSON.parse(readFileSync(full, 'utf8'));
}


/**
 * 工具注册表（MCP tools 的唯一数据源）。
 *
 * tools/list 只向客户端暴露每项的 name / description / inputSchema；
 * tools/call 则按 name 在表中找到 run 并执行。
 *
 * 约定：
 * - inputSchema 是 JSON Schema，客户端据此约束模型生成合法的 arguments；
 * - run 基本是纯读取逻辑（write_plan 是唯一例外），返回值会被 stripSensitive
 *   递归脱敏后序列化为 content 数组中的文本；
 * - run 抛出的错误由 handleToolCall 交给 tools/call 的错误响应统一处理。
 */
const TOOLS = [
  {
    // 作品概览：只返回标题、对象数、视点数与更新时间，适合作为探索的第一步。
    name: 'list_decks',
    description: '列出工作区中所有作品（标题、对象数、视点数、更新时间），只返回脱敏结构。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => {
      const snapshot = loadSnapshot();
      return {
        schema: snapshot.schema,
        generatedAt: snapshot.generatedAt,
        policy: snapshot.policy,
        decks: snapshot.decks.map((deck) => ({
          id: deck.id,
          title: deck.title,
          objectCount: deck.objectCount,
          frameCount: deck.frameCount,
          updatedAt: deck.updatedAt,
        })),
      };
    },
  },
  {
    // 单个作品的完整脱敏结构（对象、视点、背景等），先读清楚再决定如何修改。
    name: 'get_deck',
    description: '按作品 id 获取完整脱敏结构：对象参数、视点路径、背景与过渡时长。',
    inputSchema: {
      type: 'object',
      properties: { deckId: { type: 'string', description: '作品 id，来自 list_decks' } },
      required: ['deckId'],
      additionalProperties: false,
    },
    run: (args) => {
      const deck = findDeck(loadSnapshot(), args.deckId);
      if (!deck) throw new Error(`未找到作品：${args.deckId}`);
      return deck;
    },
  },
  {
    // 精确读取单个对象，常用于 update_objects 前确认现有参数。
    name: 'get_object',
    description: '按作品 id 与对象 id 读取单个对象的完整脱敏参数（不含资源内容），用于精确修改前的确认。',
    inputSchema: {
      type: 'object',
      properties: {
        deckId: { type: 'string', description: '作品 id，来自 list_decks' },
        objectId: { type: 'string', description: '对象 id，来自 get_deck 或 search_objects' },
      },
      required: ['deckId', 'objectId'],
      additionalProperties: false,
    },
    run: (args) => {
      const deck = findDeck(loadSnapshot(), args.deckId);
      if (!deck) throw new Error(`未找到作品：${args.deckId}`);
      const object = deck.objects.find((item) => item.id === args.objectId);
      if (!object) throw new Error(`作品中未找到对象：${args.objectId}`);
      return { deckId: deck.id, deckTitle: deck.title, object };
    },
  },
  {
    // 资源库元数据列表，可按类型筛选；不含二进制内容与缩略图。
    name: 'list_assets',
    description: '列出资源库元数据（名称、类型、尺寸、时长、格式）。不包含资源文件内容与缩略图。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['image', 'video', 'audio', 'model', 'file'] },
        includeDeleted: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const snapshot = loadSnapshot();
      const assets = snapshot.assets.filter((asset) => (args.includeDeleted ? true : !asset.deleted));
      return {
        count: assets.length,
        assets: args.kind ? assets.filter((asset) => asset.kind === args.kind) : assets,
      };
    },
  },
  {
    // 关键词搜索资源，返回的资源 id 可直接用于 add_asset 操作。
    name: 'search_assets',
    description:
      '按关键词搜索资源库（名称、类型、格式、扩展名），返回脱敏元数据与资源 id，供 add_asset 使用。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，为空则返回全部' },
        kind: { type: 'string', enum: ['image', 'video', 'audio', 'model', 'file'] },
        limit: { type: 'number', description: '最多返回条数，默认 40，最大 200' },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const snapshot = loadSnapshot();
      const keyword = String(args.query ?? '').trim().toLowerCase();
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 40));
      const hits = snapshot.assets
        .filter((asset) => !asset.deleted)
        .filter((asset) => (args.kind ? asset.kind === args.kind : true))
        .filter((asset) =>
          keyword
            ? `${asset.name ?? ''} ${asset.kind ?? ''} ${asset.format ?? ''} ${asset.ext ?? ''}`
                .toLowerCase()
                .includes(keyword)
            : true,
        )
        .slice(0, limit);
      return { count: hits.length, assets: hits };
    },
  },
  {
    // 按名称 / 类型 / 文本搜索对象，返回命中对象及其所属作品。
    name: 'search_objects',
    description: '按关键词搜索作品中的对象名称与类型，可限定作品 id。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，匹配对象名称或类型' },
        deckId: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: (args) => {
      const snapshot = loadSnapshot();
      const keyword = String(args.query ?? '').trim().toLowerCase();
      const decks = args.deckId
        ? snapshot.decks.filter((deck) => deck.id === args.deckId)
        : snapshot.decks;
      const hits = [];
      for (const deck of decks) {
        for (const object of deck.objects) {
          const haystack = `${object.name ?? ''} ${object.type ?? ''} ${object.text ?? ''}`.toLowerCase();
          if (keyword && haystack.includes(keyword)) {
            hits.push({ deckId: deck.id, deckTitle: deck.title, object });
          }
        }
      }
      return { count: hits.length, hits: hits.slice(0, 200) };
    },
  },
  {
    // 作品的视点（相机机位）列表，用于了解现有的叙事路径。
    name: 'list_frames',
    description: '列出某个作品的视点路径（相机目标、距离、偏航与俯仰）。',
    inputSchema: {
      type: 'object',
      properties: { deckId: { type: 'string' } },
      required: ['deckId'],
      additionalProperties: false,
    },
    run: (args) => {
      const deck = findDeck(loadSnapshot(), args.deckId);
      if (!deck) throw new Error(`未找到作品：${args.deckId}`);
      return { deckId: deck.id, title: deck.title, frames: deck.frames };
    },
  },
  {
    // 输出方案规范文档，是 write_plan 的前置阅读材料。
    name: 'plan_schema',
    description:
      '返回创作方案 3d-slide/plan@1 的完整规范：可用操作、参数、锚点语义与示例，用于 write_plan 前阅读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => planSchemaDoc(),
  },
  {
    // 唯一写入工具：把方案写入 .mcp/plans/，等待用户在应用内确认导入。
    name: 'write_plan',
    description:
      '把创作方案写入 .mcp/plans/<name>.json（唯一写入能力，不改动作品数据）。用户在应用内「AI 助手 → 导入方案」后落地。',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          description: '完整方案对象，必须含 schema: 3d-slide/plan@1 与 operations 数组',
          required: ['schema', 'operations'],
        },
        name: { type: 'string', description: '可选文件名（不含扩展名），默认取 plan.title' },
      },
      required: ['plan'],
      additionalProperties: false,
    },
    run: (args) => writePlan(args),
  },
];

/**
 * resources/list 的处理函数：把快照内容映射为一组只读资源 URI。
 *
 * URI 约定：
 * - slide://decks/<deckId>   单个作品结构
 * - slide://assets/<assetId> 单个资源元数据
 * - slide://workspace        工作区概览（统计与脱敏策略）
 * - slide://plans            方案目录清单（另支持 slide://plans/<文件名>）
 *
 * @returns {{resources: Array<{uri: string, name: string, description: string, mimeType: string}>}}
 *          MCP 资源列表；description 中带上数量，便于模型快速判断
 */
function resourcesList() {
  const snapshot = loadSnapshot();
  return {
    resources: [
      ...snapshot.decks.map((deck) => ({
        uri: `slide://decks/${deck.id}`,
        name: deck.title,
        description: `作品结构 · ${deck.objectCount} 个对象 · ${deck.frameCount} 个视点`,
        mimeType: 'application/json',
      })),
      ...snapshot.assets.map((asset) => ({
        uri: `slide://assets/${asset.id}`,
        name: asset.name,
        description: `资源元数据 · ${asset.kind}${asset.format ? ` · ${asset.format}` : ''}`,
        mimeType: 'application/json',
      })),
      {
        uri: 'slide://workspace',
        name: '工作区概览',
        description: '作品、资源与文件夹的统计与脱敏策略',
        mimeType: 'application/json',
      },
      {
        uri: 'slide://plans',
        name: '创作方案目录',
        description: `write_plan 写入的 ${PLAN_SCHEMA} 方案文件（${listPlanFiles().length} 个）`,
        mimeType: 'application/json',
      },
    ],
  };
}

/**
 * resources/read 的处理函数：按 URI 返回资源正文。
 *
 * 所有资源统一以 application/json 文本返回，客户端可直接解析：
 * - slide://workspace      工作区统计、脱敏策略与文件夹
 * - slide://plans          方案目录（含文件清单与导入提示）
 * - slide://plans/<名称>   单个方案内容
 * - slide://decks/<id>     单个作品
 * - slide://assets/<id>    单个资源元数据
 *
 * @param {string} uri resources/list 返回的 URI
 * @returns {{uri: string, mimeType: string, text: string}} 资源正文
 * @throws {Error} URI 格式不支持，或作品 / 资源 / 方案不存在时抛出
 */
function resourcesRead(uri) {
  const snapshot = loadSnapshot();
  // 工作区概览：统计信息、脱敏策略与资源文件夹。
  if (uri === 'slide://workspace') {
    return { uri, mimeType: 'application/json', text: JSON.stringify({ workspace: snapshot.workspace, policy: snapshot.policy, folders: snapshot.folders }, null, 2) };
  }
  // 方案目录：列出 .mcp/plans 下的文件，并提示如何导入。
  if (uri === 'slide://plans') {
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          schema: PLAN_SCHEMA,
          directory: plansDir,
          plans: listPlanFiles(),
          next: '在应用内打开目标作品 → AI 助手 → 导入方案，选择 .mcp/plans 下的文件即可自动落地。',
        },
        null,
        2,
      ),
    };
  }
  // slide://plans/<文件名>：读取单个方案，文件名需先做 URL 解码。
  const planMatch = uri.match(/^slide:\/\/plans\/(.+)$/);
  if (planMatch) {
    const plan = readPlanFile(decodeURIComponent(planMatch[1]));
    return { uri, mimeType: 'application/json', text: JSON.stringify(plan, null, 2) };
  }
  // slide://decks/<作品 id>：返回该作品的完整脱敏结构。
  const deckMatch = uri.match(/^slide:\/\/decks\/(.+)$/);
  if (deckMatch) {
    const deck = findDeck(snapshot, deckMatch[1]);
    if (!deck) throw new Error(`未找到作品：${deckMatch[1]}`);
    return { uri, mimeType: 'application/json', text: JSON.stringify(deck, null, 2) };
  }
  // slide://assets/<资源 id>：返回该资源的元数据（不含二进制内容）。
  const assetMatch = uri.match(/^slide:\/\/assets\/(.+)$/);
  if (assetMatch) {
    const asset = snapshot.assets.find((item) => item.id === assetMatch[1]);
    if (!asset) throw new Error(`未找到资源：${assetMatch[1]}`);
    return { uri, mimeType: 'application/json', text: JSON.stringify(asset, null, 2) };
  }
  throw new Error(`不支持的资源 URI：${uri}`);
}

/**
 * tools/call 的处理函数：查找工具、执行，并把结果包装成 MCP 约定的返回结构。
 *
 * 返回结构固定为 { content: [{ type: 'text', text: '...' }] }：
 * 工具输出统一以文本承载（这里是格式化 JSON），客户端可直接交给模型阅读。
 *
 * @param {{name?: string, arguments?: object}} params tools/call 的 params
 * @returns {{content: Array<{type: 'text', text: string}>}} MCP 工具调用结果
 * @throws {Error} 工具名未知或工具内部校验 / 执行失败时抛出，由上层转成错误响应
 */
function handleToolCall(params) {
  const tool = TOOLS.find((item) => item.name === params?.name);
  if (!tool) throw new Error(`未知工具：${params?.name}`);
  // 参数缺失或不是对象时退化为空对象，交由各工具自身的默认值处理。
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const result = tool.run(args);
  return { content: [{ type: 'text', text: JSON.stringify(stripSensitive(result), null, 2) }] };
}

/**
 * 发送 JSON-RPC 2.0 成功响应。
 *
 * stdio 传输要求每条消息独占一行并以换行结尾，客户端按行切分解析。
 *
 * @param {unknown} id     请求 id（通知类消息不会走到这里）
 * @param {unknown} result 结果对象
 */
function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

/**
 * 发送 JSON-RPC 2.0 错误响应。
 *
 * 常用错误码：-32700 解析失败、-32601 方法不存在、-32603 内部错误。
 *
 * @param {unknown} id      请求 id；消息本身无法解析时为 null
 * @param {number}  code    JSON-RPC 错误码
 * @param {string}  message 面向用户 / 模型的错误描述
 */
function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

/**
 * 分发一条已解析的 JSON-RPC 消息。
 *
 * 支持的 MCP 方法：
 * - initialize：握手，返回协议版本、能力声明（tools / resources）与服务器信息
 * - notifications/initialized：客户端通知，无需响应
 * - ping：心跳，返回空对象
 * - tools/list / tools/call：工具发现与调用
 * - resources/list / resources/read：资源发现与读取
 *
 * 通知（id 为 undefined / null）不能回写响应；未知方法在请求场景返回 -32601。
 *
 * @param {{id?: unknown, method?: string, params?: object}} message 已解析的消息
 * @returns {void}
 */
function handle(message) {
  const { id, method, params } = message;
  // 通知类消息没有 id，按 JSON-RPC 规范不得回写响应。
  const notify = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      // 握手：声明支持的能力，客户端据此决定后续可调用哪些方法。
      return respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
      // 客户端确认握手完成，按协议只需忽略。
      return undefined;
    case 'ping':
      // 心跳探测：返回空结果表示服务存活。
      return respond(id, {});
    case 'tools/list':
      // 工具发现：只暴露 name / description / inputSchema，run 函数不进入响应。
      return respond(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call':
      // 工具执行：异常统一转成 -32603，并把错误信息原样带回给模型。
      try {
        return respond(id, handleToolCall(params));
      } catch (error) {
        return fail(id, -32603, error instanceof Error ? error.message : '工具执行失败');
      }
    case 'resources/list':
      // 资源发现：返回只读 URI 列表，读取失败统一转成 -32603。
      try {
        return respond(id, resourcesList());
      } catch (error) {
        return fail(id, -32603, error instanceof Error ? error.message : '资源列表读取失败');
      }
    case 'resources/read':
      // 资源读取：结果按 MCP 约定包在 contents 数组中返回。
      try {
        return respond(id, { contents: [resourcesRead(params?.uri)] });
      } catch (error) {
        return fail(id, -32603, error instanceof Error ? error.message : '资源读取失败');
      }
    default:
      // 未知方法：通知直接忽略；请求则返回「方法不存在」（-32601）。
      if (notify) return undefined;
      return fail(id, -32601, `未实现的方法：${method}`);
  }
}

// stdin 读取循环：每条非空行视为一条 JSON-RPC 消息（stdio 传输约定）。
// crlfDelay: Infinity 让 Windows 的 \r\n 与 Unix 的 \n 都能正确切分。
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  const trimmed = line.trim();
  // 忽略空行，方便客户端拼接消息时留出空白行。
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    // 解析失败按 JSON-RPC 规范返回 -32700；此时拿不到 id，只能用 null。
    return fail(null, -32700, 'JSON 解析失败');
  }
  try {
    handle(message);
  } catch (error) {
    // 兜底捕获未预期异常，仅在消息带 id 时回写错误响应。
    if (message?.id !== undefined) {
      fail(message.id, -32603, error instanceof Error ? error.message : '内部错误');
    }
  }
});
// 客户端关闭输入流或流结束时退出进程，避免留下残留的子进程。
reader.on('close', () => process.exit(0));

process.stdin.on('end', () => process.exit(0));
