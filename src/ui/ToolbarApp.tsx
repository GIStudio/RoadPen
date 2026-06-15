import { useEffect, useState } from "react";
import { Button, Checkbox, Descriptions, Divider, Drawer, InputNumber, Segmented, Space, Switch, Tag, Typography } from "antd";
import { DEBUG_LAYER_KEYS, DEFAULT_DEBUG_SETTINGS, GEOMETRY_ISSUE_TYPES, type DebugLayerKey, type GeometryIssueReport, type GeometryIssueType, type JunctionInspectorDetails, type RoadEndMode, type RoadInspectorDetails, type ToolbarAction, type ToolbarState } from "../types";

const TOOLBAR_MODES: Array<{ label: string; value: "select" | "draw" }> = [
  { label: "选择", value: "select" },
  { label: "绘制", value: "draw" },
];

const DEFAULT_STATE: ToolbarState = {
  mode: "select",
  endMode: "free",
  selectedRoadLayer: 0,
  debug: DEFAULT_DEBUG_SETTINGS,
  debugPanelOpen: false,
  selectedRoad: null,
  selectedJunction: null,
  geometryIssues: {
    counts: GEOMETRY_ISSUE_TYPES.reduce(
      (acc, type) => {
        acc[type] = 0;
        return acc;
      },
      {} as GeometryIssueReport["counts"],
    ),
    markers: [],
  },
  draftPoints: 0,
  warningCount: 0,
  canFinish: false,
};

const DEBUG_LAYER_LABELS: Record<DebugLayerKey, string> = {
  junctionSurface: "路口行车面",
  laneConnectors: "外侧 lane connector",
  roadSkeleton: "道路骨架/转角",
  junctionBranches: "路口分支",
  laneStops: "lane stop",
  geometryIssues: "几何问题",
};

const GEOMETRY_ISSUE_LABELS: Record<GeometryIssueType, string> = {
  crossLayerOverlap: "跨层遮挡",
  sameLayerUnsplitCrossing: "同层未拆分",
  shortEdgeStub: "短 stub",
  junctionSurfaceGapCandidate: "路口缺口候选",
  sharpCornerGapCandidate: "锐角候选",
  outerLaneCoverageGap: "外侧 lane 缺口",
  extremeTurnFallback: "极限角 fallback",
  selfOverlapCandidate: "自重叠候选",
  localZOrderApplied: "局部层级已应用",
};

function emitAction(action: ToolbarAction): void {
  window.dispatchEvent(new CustomEvent<ToolbarAction>("roadpen:action", { detail: action }));
}

function emitEndMode(value: RoadEndMode): void {
  emitAction({ type: "setEndMode", endMode: value });
}

function fmt(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function RoadDetails({ details, inspectorEnabled }: { details: RoadInspectorDetails | null; inspectorEnabled: boolean }): JSX.Element {
  if (!inspectorEnabled) {
    return <Typography.Text type="secondary">开启“点击道路展示参数”后，在选择模式点击可见路面查看道路参数。</Typography.Text>;
  }

  if (!details) {
    return <Typography.Text type="secondary">当前未选中道路。点击画布上的路面区域查看参数。</Typography.Text>;
  }

  const profile = details.profile;
  return (
    <Space direction="vertical" size={12} className="road-details">
      <Descriptions size="small" bordered column={1}>
        <Descriptions.Item label="Edge">{details.edge.id}</Descriptions.Item>
        <Descriptions.Item label="From / To">{details.edge.from} -&gt; {details.edge.to}</Descriptions.Item>
        <Descriptions.Item label="类型">{details.edge.geomType}</Descriptions.Item>
        <Descriptions.Item label="端点">{details.edge.endMode}</Descriptions.Item>
        <Descriptions.Item label="Layer">
          <InputNumber
            size="small"
            step={1}
            value={details.edge.layer}
            onChange={(value) => emitAction({ type: "setSelectedRoadLayer", edgeId: details.edge.id, layer: Number(value ?? 0) })}
            style={{ width: 80 }}
          />
        </Descriptions.Item>
        <Descriptions.Item label="Profile">{details.edge.profileId}</Descriptions.Item>
        <Descriptions.Item label="长度">{fmt(details.edge.length)} px</Descriptions.Item>
      </Descriptions>

      <Descriptions title="Profile 宽度" size="small" bordered column={1}>
        <Descriptions.Item label="车行道">{profile ? fmt(profile.carriagewayWidth) : "-"}</Descriptions.Item>
        <Descriptions.Item label="设施带">{profile ? fmt(profile.facilityWidth) : "-"}</Descriptions.Item>
        <Descriptions.Item label="人行道">{profile ? fmt(profile.sidewalkWidth) : "-"}</Descriptions.Item>
        <Descriptions.Item label="净空">{profile ? fmt(profile.clearanceWidth) : "-"}</Descriptions.Item>
      </Descriptions>

      <Descriptions title="渲染链路" size="small" bordered column={1}>
        <Descriptions.Item label="Chain">{details.visualChain?.id ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="Edges">{details.visualChain?.edgeIds.join(" + ") ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="点数">
          {details.visualChain
            ? `raw ${details.visualChain.rawPointCount} / source ${details.visualChain.sourcePointCount} / render ${details.visualChain.renderPointCount}`
            : "-"}
        </Descriptions.Item>
        <Descriptions.Item label="Turns">{details.visualChain?.turnCount ?? "-"}</Descriptions.Item>
      </Descriptions>

      <div>
        <Typography.Text className="debug-section-title">端点路口</Typography.Text>
        <div className="debug-tags">
          {details.endpoints.map((endpoint) => (
            <Tag key={endpoint.nodeId} color={endpoint.degree >= 3 ? "magenta" : "blue"}>
              {endpoint.nodeId}: {endpoint.junctionType ?? "none"} / deg {endpoint.degree}
            </Tag>
          ))}
        </div>
      </div>

      <div>
        <Typography.Text className="debug-section-title">控制点 ({details.edge.controlPointCount})</Typography.Text>
        <pre className="debug-code">
          {details.edge.controlPoints.map((point, index) => `p${index}: ${fmt(point.x)}, ${fmt(point.y)}`).join("\n")}
        </pre>
      </div>
    </Space>
  );
}

function JunctionDetails({ details, inspectorEnabled }: { details: JunctionInspectorDetails | null; inspectorEnabled: boolean }): JSX.Element {
  if (!inspectorEnabled) {
    return <Typography.Text type="secondary">开启“点击路口展示参数”后，在选择模式点击路口行车面或标签查看路口块。</Typography.Text>;
  }

  if (!details) {
    return <Typography.Text type="secondary">当前未选中路口。点击路口面、connector 或路口标签查看参数。</Typography.Text>;
  }

  return (
    <Space direction="vertical" size={12} className="road-details">
      <Descriptions size="small" bordered column={1}>
        <Descriptions.Item label="Block">{details.id}</Descriptions.Item>
        <Descriptions.Item label="Node">{details.nodeId}</Descriptions.Item>
        <Descriptions.Item label="Layer">{details.layer}</Descriptions.Item>
        <Descriptions.Item label="类型">{details.type}</Descriptions.Item>
        <Descriptions.Item label="Degree">{details.degree}</Descriptions.Item>
        <Descriptions.Item label="位置">{fmt(details.point.x)}, {fmt(details.point.y)}</Descriptions.Item>
      </Descriptions>

      <Descriptions title="路口几何" size="small" bordered column={1}>
        <Descriptions.Item label="Connections">{details.connectionCount}</Descriptions.Item>
        <Descriptions.Item label="Mouth lines">{details.mouthLineCount}</Descriptions.Item>
        <Descriptions.Item label="Surface patches">{details.surfacePatchCount}</Descriptions.Item>
        <Descriptions.Item label="Lane connectors">{details.laneConnectorCount}</Descriptions.Item>
        <Descriptions.Item label="Lane stops">{details.laneStopCount}</Descriptions.Item>
        <Descriptions.Item label="Virtual boundary">{details.virtualBoundary ? "yes" : "no"}</Descriptions.Item>
      </Descriptions>

      <div>
        <Typography.Text className="debug-section-title">分支 ({details.branchCount})</Typography.Text>
        <div className="debug-tags">
          {details.branches.map((branch) => (
            <Tag key={branch.edgeId} color="purple">
              {branch.edgeId} / L{branch.layer} / {branch.profileId}
            </Tag>
          ))}
        </div>
      </div>
    </Space>
  );
}

export function ToolbarApp(): JSX.Element {
  const [state, setState] = useState<ToolbarState>(DEFAULT_STATE);

  useEffect(() => {
    const onState = (event: Event): void => {
      const nextState = (event as CustomEvent<ToolbarState>).detail;
      if (!nextState) {
        return;
      }
      setState(nextState);
    };

    window.addEventListener("roadpen:state", onState as EventListener);
    return () => {
      window.removeEventListener("roadpen:state", onState as EventListener);
    };
  }, []);

  return (
    <div className="toolbar-action-wrap">
      <Segmented
        options={TOOLBAR_MODES}
        value={state.mode}
        onChange={(value) => emitAction({ type: "setMode", mode: value as "select" | "draw" })}
      />
      <Segmented
        size="small"
        options={[
          { label: "末端自由", value: "free" },
          { label: "圆头封闭", value: "closed" },
        ]}
        value={state.endMode}
        onChange={(value) => emitEndMode(value as RoadEndMode)}
      />
      <Space size={6} align="center">
        <Typography.Text type="secondary">层级</Typography.Text>
        <InputNumber
          size="small"
          step={1}
          value={state.selectedRoadLayer}
          onChange={(value) => emitAction({ type: "setRoadLayer", layer: Number(value ?? 0) })}
          style={{ width: 72 }}
        />
      </Space>
      <Button
        danger
        type="primary"
        onClick={() => emitAction({ type: "finish" })}
        disabled={!state.canFinish}
      >
        结束绘制
      </Button>
      <Button type="primary" onClick={() => emitAction({ type: "export" })}>
        导出
      </Button>
      <Button type="default" onClick={() => emitAction({ type: "exportSvg" })}>
        导出 SVG
      </Button>
      <Button type="default" onClick={() => emitAction({ type: "loadValidationScene" })}>
        验证场景
      </Button>
      <Button
        type={
          state.debugPanelOpen ||
          state.debug.enabled ||
          state.debug.roadInspector ||
          state.debug.junctionInspector ||
          state.debug.isolateSelectedJunction
            ? "primary"
            : "default"
        }
        onClick={() => emitAction({ type: "setDebugPanelOpen", open: !state.debugPanelOpen })}
      >
        调试
      </Button>
      <Button type="default" onClick={() => emitAction({ type: "import" })}>
        导入
      </Button>
      <Drawer
        title="调试"
        placement="right"
        width={390}
        mask={false}
        open={state.debugPanelOpen}
        onClose={() => emitAction({ type: "setDebugPanelOpen", open: false })}
      >
        <div className="debug-drawer">
          <section className="debug-section">
            <div className="debug-row">
              <div>
                <Typography.Text strong>调试图层</Typography.Text>
                <Typography.Text type="secondary" className="debug-row-caption">控制画布上的调试覆盖层</Typography.Text>
              </div>
              <Switch
                checked={state.debug.enabled}
                onChange={(enabled) => emitAction({ type: "setDebugEnabled", enabled })}
              />
            </div>
            <div className="debug-layer-list">
              {DEBUG_LAYER_KEYS.map((layer) => (
                <Checkbox
                  key={layer}
                  checked={state.debug.layers[layer]}
                  onChange={(event) => emitAction({ type: "setDebugLayer", layer, enabled: event.target.checked })}
                >
                  {DEBUG_LAYER_LABELS[layer]}
                </Checkbox>
              ))}
            </div>
          </section>

          <Divider />

          <section className="debug-section">
            <Typography.Text strong>几何问题计数</Typography.Text>
            <Typography.Text type="secondary" className="debug-row-caption">
              诊断只标记候选位置，不自动修改旧场景拓扑
            </Typography.Text>
            <div className="debug-tags">
              {GEOMETRY_ISSUE_TYPES.map((type) => {
                const count = state.geometryIssues.counts[type] ?? 0;
                return (
                  <Tag key={type} color={count > 0 ? "orange" : "default"}>
                    {GEOMETRY_ISSUE_LABELS[type]}: {count}
                  </Tag>
                );
              })}
            </div>
          </section>

          <Divider />

          <section className="debug-section">
            <div className="debug-row">
              <div>
                <Typography.Text strong>点击道路展示参数</Typography.Text>
                <Typography.Text type="secondary" className="debug-row-caption">选择模式下点击可见路面拾取道路</Typography.Text>
              </div>
              <Switch
                checked={state.debug.roadInspector}
                onChange={(enabled) => emitAction({ type: "setRoadInspector", enabled })}
              />
            </div>
          </section>

          <Divider />

          <section className="debug-section">
            <div className="debug-row">
              <div>
                <Typography.Text strong>点击路口展示参数</Typography.Text>
                <Typography.Text type="secondary" className="debug-row-caption">选择模式下点击路口块、connector 或标签</Typography.Text>
              </div>
              <Switch
                checked={state.debug.junctionInspector}
                onChange={(enabled) => emitAction({ type: "setJunctionInspector", enabled })}
              />
            </div>
            <div className="debug-row">
              <div>
                <Typography.Text strong>单独展示选中路口</Typography.Text>
                <Typography.Text type="secondary" className="debug-row-caption">临时隐藏道路段和其他路口</Typography.Text>
              </div>
              <Switch
                checked={state.debug.isolateSelectedJunction}
                disabled={!state.selectedJunction}
                onChange={(enabled) => emitAction({ type: "setIsolateSelectedJunction", enabled })}
              />
            </div>
            {state.selectedJunction ? (
              <Button size="small" onClick={() => emitAction({ type: "clearJunctionSelection" })}>
                清除路口选择
              </Button>
            ) : null}
          </section>

          <Divider />

          <section className="debug-section">
            <Typography.Title level={5}>路口参数</Typography.Title>
            <JunctionDetails details={state.selectedJunction} inspectorEnabled={state.debug.junctionInspector} />
          </section>

          <Divider />

          <section className="debug-section">
            <Typography.Title level={5}>道路参数</Typography.Title>
            <RoadDetails details={state.selectedRoad} inspectorEnabled={state.debug.roadInspector} />
          </section>
        </div>
      </Drawer>
    </div>
  );
}
