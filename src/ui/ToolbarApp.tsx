import { useEffect, useState } from "react";
import { Button, Segmented } from "antd";
import type { RoadEndMode, ToolbarAction, ToolbarState } from "../types";

const TOOLBAR_MODES: Array<{ label: string; value: "select" | "draw" }> = [
  { label: "选择", value: "select" },
  { label: "绘制", value: "draw" },
];

const DEFAULT_STATE: ToolbarState = {
  mode: "select",
  endMode: "free",
  debugMode: false,
  draftPoints: 0,
  warningCount: 0,
  canFinish: false,
};

function emitAction(action: ToolbarAction): void {
  window.dispatchEvent(new CustomEvent<ToolbarAction>("roadpen:action", { detail: action }));
}

function emitEndMode(value: RoadEndMode): void {
  emitAction(value === "closed" ? "endClosed" : "endFree");
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
        onChange={(value) => emitAction(value as "select" | "draw")}
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
      <Button
        danger
        type="primary"
        onClick={() => emitAction("finish")}
        disabled={!state.canFinish}
      >
        结束绘制
      </Button>
      <Button type="primary" onClick={() => emitAction("export")}>
        导出
      </Button>
      <Button type="default" onClick={() => emitAction("exportSvg")}>
        导出 SVG
      </Button>
      <Button
        type={state.debugMode ? "primary" : "default"}
        onClick={() => emitAction("toggleDebug")}
      >
        {state.debugMode ? "调试：开" : "调试：关"}
      </Button>
      <Button type="default" onClick={() => emitAction("import")}>
        导入
      </Button>
    </div>
  );
}
