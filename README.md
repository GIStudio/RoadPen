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

## 当前几何优化计划

RoadPen 的场景文件仍只持久化 `nodes / edges / profiles`。路口、mouth、车行道补片、外侧 lane connector 都应由拓扑自动派生，不写入场景文件。

当前优先级：

1. 路口几何改为 connection-first：在 `JunctionBlock` 内先派生有方向的 `JunctionConnection`，再由 connection swept area 生成车行道 surface 和外侧 lane connector。
2. 修复大转角 / T/Y/X 路口空洞：车行道不能落后于外侧 lane connector，所有 from-edge 到 to-edge 的转弯补片必须可调试、可定位。
3. 调试和 SVG 归因：路口 surface、lane connector、mouth line、lane stop 继续挂 `data-junction-block-id`，并补充 connection id / from-to edge 元数据。
4. 普通 road chain 的 sharp corner fallback：非路口道路继续使用 offset band，但需要补 miter / bevel / round 退化策略，避免近似平行和极锐角尖刺。
5. 测试场景：覆盖 T/Y/X、斜向十字、大转角右转、near-parallel sharp corner、SVG metadata、路口隔离显示。

参考调研见 [`docs/road-geometry-reference.md`](docs/road-geometry-reference.md)。

## 多子图验证图集

固定验证场景可以作为“多案例单场景”维护：在同一个 `.roadpen.json` 里手动画多个相距较远的道路案例，例如单条直路、S 弯、T/X/Y 路口、近 180 度大角、短控制点、跨层匝道、停车岛等。

测试侧会按道路空间聚类自动拆成子图，并输出一张 atlas PNG：

- 整体渲染：`test-artifacts/parking-lot-validation.png`
- 多子图 atlas：`test-artifacts/parking-lot-validation-atlas.png`

atlas 的每个 panel 顶部显示：

- `Sxx`：子图编号
- `Exx`：该子图 RoadEdge 数量
- `Wxx`：该子图几何 warning 数量
- `LGxx`：该子图 outer lane gap 候选数量

默认聚类半径为 32px。共享节点、bbox 重叠或足够接近的道路会进入同一个子图；相距较远的案例会分到不同 panel。这样可以在一张图里同时观察所有几何回归点，而不需要逐个缩放查找。

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
