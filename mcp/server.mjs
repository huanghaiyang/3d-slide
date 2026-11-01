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
 */
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_INFO = { name: '3d-slide-mcp', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';
const SENSITIVE_KEY = /(apikey|api_key|token|secret|password|passwd|authorization|cookie|credential|privatekey)/i;

const here = dirname(fileURLToPath(import.meta.url));
const snapshotPath = resolve(
  process.env.SLIDE_SNAPSHOT || join(here, '..', '.mcp', 'workspace-snapshot.json'),
);
const plansDir = resolve(process.env.SLIDE_PLANS_DIR || join(here, '..', '.mcp', 'plans'));

const PLAN_SCHEMA = '3d-slide/plan@1';
const PLAN_MAX_OPERATIONS = 120;
const PLAN_OPERATIONS = [
  'add_text',
  'add_shape',
  'add_asset',
  'update_objects',
  'delete_objects',
  'set_deck',
  'create_view',
];
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

let cache = null;
let cacheKey = '';

function loadSnapshot() {
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

function findDeck(snapshot, deckId) {
  return snapshot.decks.find((deck) => deck.id === deckId) ?? null;
}

/* --------------------------- 创作方案（plan） --------------------------- */

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

const PLAN_PLACEMENT =
  '所有 add_* 操作都支持 anchor（画面锚点）与 dx/dy（百分比 -100~100 微调），无需手算世界坐标：' +
  '画面右下 = 世界 +X/+Y 的反向由引擎处理。';

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

function writePlan(args) {
  const plan = validatePlan(args.plan);
  const base = sanitizePlanName(args.name) || sanitizePlanName(plan.title) || `plan-${Date.now()}`;
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

function listPlanFiles() {
  if (!existsSync(plansDir)) return [];
  return readdirSync(plansDir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => {
      const info = statSync(join(plansDir, name));
      return { name, path: `.mcp/plans/${name}`, size: info.size, updatedAt: info.mtimeMs };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function readPlanFile(name) {
  const safe = String(name ?? '').replace(/[\\/]+/g, '');
  if (!safe.toLowerCase().endsWith('.json')) throw new Error('方案文件名必须以 .json 结尾');
  const full = join(plansDir, safe);
  if (!existsSync(full)) throw new Error(`未找到方案文件：${safe}`);
  return JSON.parse(readFileSync(full, 'utf8'));
}


const TOOLS = [
  {
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
    name: 'plan_schema',
    description:
      '返回创作方案 3d-slide/plan@1 的完整规范：可用操作、参数、锚点语义与示例，用于 write_plan 前阅读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => planSchemaDoc(),
  },
  {
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

function resourcesRead(uri) {
  const snapshot = loadSnapshot();
  if (uri === 'slide://workspace') {
    return { uri, mimeType: 'application/json', text: JSON.stringify({ workspace: snapshot.workspace, policy: snapshot.policy, folders: snapshot.folders }, null, 2) };
  }
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
  const planMatch = uri.match(/^slide:\/\/plans\/(.+)$/);
  if (planMatch) {
    const plan = readPlanFile(decodeURIComponent(planMatch[1]));
    return { uri, mimeType: 'application/json', text: JSON.stringify(plan, null, 2) };
  }
  const deckMatch = uri.match(/^slide:\/\/decks\/(.+)$/);
  if (deckMatch) {
    const deck = findDeck(snapshot, deckMatch[1]);
    if (!deck) throw new Error(`未找到作品：${deckMatch[1]}`);
    return { uri, mimeType: 'application/json', text: JSON.stringify(deck, null, 2) };
  }
  const assetMatch = uri.match(/^slide:\/\/assets\/(.+)$/);
  if (assetMatch) {
    const asset = snapshot.assets.find((item) => item.id === assetMatch[1]);
    if (!asset) throw new Error(`未找到资源：${assetMatch[1]}`);
    return { uri, mimeType: 'application/json', text: JSON.stringify(asset, null, 2) };
  }
  throw new Error(`不支持的资源 URI：${uri}`);
}

function handleToolCall(params) {
  const tool = TOOLS.find((item) => item.name === params?.name);
  if (!tool) throw new Error(`未知工具：${params?.name}`);
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const result = tool.run(args);
  return { content: [{ type: 'text', text: JSON.stringify(stripSensitive(result), null, 2) }] };
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  const notify = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      return respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
      return undefined;
    case 'ping':
      return respond(id, {});
    case 'tools/list':
      return respond(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call':
      try {
        return respond(id, handleToolCall(params));
      } catch (error) {
        return fail(id, -32603, error instanceof Error ? error.message : '工具执行失败');
      }
    case 'resources/list':
      try {
        return respond(id, resourcesList());
      } catch (error) {
        return fail(id, -32603, error instanceof Error ? error.message : '资源列表读取失败');
      }
    case 'resources/read':
      try {
        return respond(id, { contents: [resourcesRead(params?.uri)] });
      } catch (error) {
        return fail(id, -32603, error instanceof Error ? error.message : '资源读取失败');
      }
    default:
      if (notify) return undefined;
      return fail(id, -32601, `未实现的方法：${method}`);
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return fail(null, -32700, 'JSON 解析失败');
  }
  try {
    handle(message);
  } catch (error) {
    if (message?.id !== undefined) {
      fail(message.id, -32603, error instanceof Error ? error.message : '内部错误');
    }
  }
});
reader.on('close', () => process.exit(0));

process.stdin.on('end', () => process.exit(0));
