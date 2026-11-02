/**
 * plugins/g6/Inspector.tsx —— G6 图表的属性面板
 *
 * 面板只负责显示与提交，不直接读写 store：
 * 所有修改通过父级传入的 onChange 交回核心，由核心统一写入撤销历史与自动保存。
 *
 * 图表保存的是声明式数据（布局 / 节点 / 边 / 配色），而不是渲染结果：
 * 每次修改都先深拷贝、再规范化后提交，SceneManager 依据数据指纹判断是否重建
 * G6 实例，因此编辑会实时反映到 3D 画面。删除节点时会同步移除引用它的连线，
 * 避免产生孤立边。
 */

import { Icon } from '../../components/Icon';
import { Section, TextValueField } from '../../components/inspectorKit';
import { ColorField, Switch } from '../../components/ui';
import type { ChartInspectorProps } from '../types';
import { G6_KIND_LABELS, G6_LAYOUT_LABELS, G6_MAX_EDGES, G6_MAX_NODES, G6_PRESETS, cloneG6Spec, normalizeG6Spec } from './chart';
import type { G6ChartLayout, G6ChartNodeKind, G6ChartSpec } from './types';

/** 节点文案输入的最大长度，与规范化规则保持一致。 */
const MAX_LABEL_CHARS = 28;

/**
 * G6 图表属性面板。
 *
 * @param props.object    当前图表对象
 * @param props.onChange  提交数据 / 动画开关
 * @param props.error     渲染错误提示
 * @param props.onRetry   重新挂载渲染
 */
export function G6ChartInspector({ object, onChange, error, onRetry }: ChartInspectorProps) {
  /**
   * 深拷贝后修改并规范化提交；相同 field 的连续操作合并为一步撤销。
   *
   * 对象里的 spec 在写入 store 与导入存档时都已被规范化，因此这里可以安全地
   * 按 G6ChartSpec 处理；规范化仍然保留，用于兜底第三方写入的异常数据。
   */
  const patchSpec = (mutate: (draft: G6ChartSpec) => void, field: string) => {
    const draft = cloneG6Spec(normalizeG6Spec(object.spec));
    mutate(draft);
    onChange({ spec: normalizeG6Spec(draft) }, `${object.id}:${field}`);
  };

  // 展示用数据：同样先规范化，保证面板不会因为脏数据出现空下拉框
  const spec = normalizeG6Spec(object.spec);
  const nodes = spec.nodes;
  const edges = spec.edges;

  /** 生成不与现有节点冲突的新节点 id。 */
  const nextNodeId = () => {
    let index = nodes.length + 1;
    while (nodes.some((node) => node.id === `n${index}`)) index += 1;
    return `n${index}`;
  };

  return (
    <>
      <Section title="图表">
        <div className="prop-row">
          <span className="field-label">布局</span>
          <select
            className="select"
            value={spec.layout}
            aria-label="图表布局"
            onChange={(event) =>
              patchSpec((draft) => {
                draft.layout = event.target.value as G6ChartLayout;
              }, 'layout')
            }
          >
            {(Object.keys(G6_LAYOUT_LABELS) as G6ChartLayout[]).map((layout) => (
              <option key={layout} value={layout}>
                {G6_LAYOUT_LABELS[layout]}
              </option>
            ))}
          </select>
        </div>

        {/* 辐射布局需要一个中心节点，其余布局忽略该字段 */}
        {spec.layout === 'radial' && (
          <div className="prop-row">
            <span className="field-label">中心节点</span>
            <select
              className="select"
              value={spec.focusNode ?? nodes[0]?.id ?? ''}
              aria-label="辐射中心节点"
              onChange={(event) =>
                patchSpec((draft) => {
                  draft.focusNode = event.target.value;
                }, 'focus')
              }
            >
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.label || node.id}
                </option>
              ))}
            </select>
          </div>
        )}

        <ColorField
          label="强调色"
          value={spec.accent}
          ariaLabel="图表强调色"
          onChange={(accent) =>
            patchSpec((draft) => {
              draft.accent = accent;
            }, 'accent')
          }
        />

        <div className="prop-row">
          <span className="field-label">布局动画</span>
          <Switch
            checked={object.animate}
            label="图表布局动画"
            onChange={(animate) => onChange({ animate })}
          />
        </div>

        <div className="prop-row">
          <span className="field-label">载入示例</span>
          <select
            className="select"
            value=""
            aria-label="载入图表示例"
            onChange={(event) => {
              const preset = G6_PRESETS.find((item) => item.id === event.target.value);
              if (!preset) return;
              patchSpec((draft) => {
                const source = cloneG6Spec(preset.spec);
                draft.layout = source.layout;
                draft.nodes = source.nodes;
                draft.edges = source.edges;
                draft.accent = source.accent;
                draft.focusNode = source.focusNode;
              }, 'preset');
            }}
          >
            <option value="">选择示例…</option>
            {G6_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </div>

        <span className="field-hint">
          {nodes.length} 个节点 · {edges.length} 条连线 · 数据随作品保存，修改后实时重排。
        </span>
      </Section>

      <Section title="节点">
        <div className="chart-rows">
          {nodes.map((node) => (
            <div key={node.id} className="chart-row">
              <TextValueField
                value={node.label}
                maxLength={MAX_LABEL_CHARS}
                ariaLabel={`节点 ${node.id} 文案`}
                onCommit={(label) =>
                  patchSpec((draft) => {
                    const target = draft.nodes.find((item) => item.id === node.id);
                    if (target) target.label = label;
                  }, `node-label:${node.id}`)
                }
              />
              <select
                className="select"
                value={node.kind ?? 'node'}
                aria-label={`节点 ${node.id} 层级`}
                onChange={(event) =>
                  patchSpec((draft) => {
                    const target = draft.nodes.find((item) => item.id === node.id);
                    if (target) target.kind = event.target.value as G6ChartNodeKind;
                  }, `node-kind:${node.id}`)
                }
              >
                {(Object.keys(G6_KIND_LABELS) as G6ChartNodeKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {G6_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="chart-row-del"
                aria-label={`删除节点 ${node.label || node.id}`}
                onClick={() =>
                  patchSpec((draft) => {
                    draft.nodes = draft.nodes.filter((item) => item.id !== node.id);
                    // 节点删除后，引用它的边也必须一起删除，否则会变成孤立边
                    draft.edges = draft.edges.filter(
                      (edge) => edge.source !== node.id && edge.target !== node.id,
                    );
                    if (draft.focusNode === node.id) draft.focusNode = undefined;
                  }, `node-del:${node.id}`)
                }
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={nodes.length >= G6_MAX_NODES}
          onClick={() =>
            patchSpec((draft) => {
              draft.nodes.push({ id: nextNodeId(), label: '新节点', kind: 'node' });
            }, 'node-add')
          }
        >
          <Icon name="plus" size={14} /> 添加节点
        </button>
      </Section>

      <Section title="连线">
        <div className="chart-rows">
          {edges.map((edge, index) => (
            <div key={`${edge.source}>${edge.target}>${index}`} className="chart-row chart-edge-row">
              <select
                className="select"
                value={edge.source}
                aria-label={`连线 ${index + 1} 起点`}
                onChange={(event) =>
                  patchSpec((draft) => {
                    const target = draft.edges[index];
                    if (target) target.source = event.target.value;
                  }, `edge-source:${index}`)
                }
              >
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label || node.id}
                  </option>
                ))}
              </select>
              <select
                className="select"
                value={edge.target}
                aria-label={`连线 ${index + 1} 终点`}
                onChange={(event) =>
                  patchSpec((draft) => {
                    const target = draft.edges[index];
                    if (target) target.target = event.target.value;
                  }, `edge-target:${index}`)
                }
              >
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label || node.id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="chart-row-del"
                aria-label={`删除连线 ${index + 1}`}
                onClick={() =>
                  patchSpec((draft) => {
                    draft.edges = draft.edges.filter((_, itemIndex) => itemIndex !== index);
                  }, `edge-del:${index}`)
                }
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={nodes.length < 2 || edges.length >= G6_MAX_EDGES}
          onClick={() =>
            patchSpec((draft) => {
              // 默认连接前两个节点；重复连线会在规范化时被剔除
              draft.edges.push({ source: draft.nodes[0].id, target: draft.nodes[1].id });
            }, 'edge-add')
          }
        >
          <Icon name="plus" size={14} /> 添加连线
        </button>
        <span className="field-hint">自环与重复连线会被自动忽略；节点最多 {G6_MAX_NODES} 个。</span>
      </Section>

      {error && (
        <div className="image-error-box">
          <Icon name="alert" size={15} />
          <div>
            <b>图表无法渲染</b>
            <p>{error}</p>
            <div className="button-row">
              <button className="btn btn-light btn-sm" onClick={onRetry}>
                重试
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
