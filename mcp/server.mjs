#!/usr/bin/env node
/**
 * 3d-slide MCP 服务（零依赖，stdio JSON-RPC）
 *
 * 使用方式：
 *   1. 在应用内「AI 助手与集成」中导出脱敏快照 workspace-snapshot.json
 *   2. 运行：SLIDE_SNAPSHOT=workspace-snapshot.json npm run mcp
 *   3. 在 MCP 客户端中注册：
 *      { "command": "node", "args": ["mcp/server.mjs"],
 *        "env": { "SLIDE_SNAPSHOT": "workspace-snapshot.json" } }
 *
 * 安全规则：快照本身不含资源文件内容与任何密钥；本服务也不会读取资源二进制，
 * 仅暴露作品结构、资源元数据与视点信息（只读）。
 */
import { createInterface } from 'node:readline';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_INFO = { name: '3d-slide-mcp', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';
const SENSITIVE_KEY = /(apikey|api_key|token|secret|password|passwd|authorization|cookie|credential|privatekey)/i;

const here = dirname(fileURLToPath(import.meta.url));
const snapshotPath = resolve(
  process.env.SLIDE_SNAPSHOT || join(here, '..', '.mcp', 'workspace-snapshot.json'),
);

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
    ],
  };
}

function resourcesRead(uri) {
  const snapshot = loadSnapshot();
  if (uri === 'slide://workspace') {
    return { uri, mimeType: 'application/json', text: JSON.stringify({ workspace: snapshot.workspace, policy: snapshot.policy, folders: snapshot.folders }, null, 2) };
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
