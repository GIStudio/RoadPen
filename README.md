# RoadPen

RoadPen 是一个纯前端的道路绘制原型，支持：

- 绘制：节点吸附 + 线段/曲线道路
- 导出：JSON 文件（`.roadpen.json`）
- 导入：从 `.roadpen.json` 恢复场景并继续编辑
- 多带渲染：车行道、设施带、人行道、净空带
- 分析型几何管线：拐点平滑、端点偏移、同层道路布尔并道

## 快速启动

```bash
cd /Users/shiqi/Coding/GIStudio/RoadPen
npm install
npm run dev
```

启动后不要用 `file://` 打开本地 `index.html`，请打开：

`http://127.0.0.1:4173`

如果 `4173` 被占用，Vite 会自动换到其他可用端口。

## 文件结构

- `src/main.ts`：单页交互（绘制/拖拽/导入导出）
- `src/geometry/*`：几何核（曲线拟合、转角参数、带状面片构建、并道）
- `src/io/io.ts`：`RoadPenScene` 的序列化与反序列化
- `src/render/roadRenderer.ts`：Canvas 分层绘制
- `index.html`：工具栏与画布容器

## 导入导出文件说明

导出的 JSON 使用以下外层结构：

```json
{
  "version": "1.0.0",
  "exportedAt": "2026-05-01T...Z",
  "scene": {
    "version": "1.0.0",
    "units": "px",
    "scalePxPerM": 20,
    "nodes": [...],
    "edges": [...],
    "profiles": [...]
  }
}
```

- 导入时若 `scene` 字段缺失，会自动回退到根对象兼容旧格式。
