# Road Geometry Reference Notes

调研日期：2026-06-12

本轮只做算法参考，不 vendoring、不复制第三方实现。第三方源码 shallow clone 到 `/private/tmp/roadpen-map-refs`，RoadPen 仓库只新增本文档。

## Snapshot

| Library | Local path | Commit | 主要参考文件 |
| --- | --- | --- | --- |
| SUMO | `/private/tmp/roadpen-map-refs/sumo` | `7cd06c9f399b0ca6fd8fe8bb75f495026ff20987` | `src/netbuild/NBNode.cpp`, `src/netbuild/NBNodeShapeComputer.cpp`, `src/netbuild/NBNode.h` |
| MapLibre GL JS | `/private/tmp/roadpen-map-refs/maplibre-gl-js` | `5c78c3fc2170b34a337151585ec45ea1c026ae94` | `src/data/bucket/line_bucket.ts` |
| OpenLayers | `/private/tmp/roadpen-map-refs/openlayers` | `a638a7004a2628438fb8c3180e3872e67404e2d7` | `src/ol/style/Stroke.js`, `src/ol/render/canvas.js`, `src/ol/render/canvas/PolygonBuilder.js` |
| Lanelet2 | `/private/tmp/roadpen-map-refs/lanelet2` | `62ef988b0a14487c69b07050d7aa0a787ff24ff3` | `lanelet2_core/include/lanelet2_core/primitives/Lanelet.h`, `lanelet2_core/src/Lanelet.cpp`, `lanelet2_routing/src/RoutingGraphBuilder.cpp` |

## Executive Decision

RoadPen 不应该从“扩大 junction hull”解决路口空洞。更稳的方向是：

1. 普通道路段继续使用 centerline offset band。
2. `degree >= 3` 的路口使用 connection-first：先派生有方向的 `JunctionConnection`，再由 connection swept area 反推 carriageway surface。
3. `JunctionBlock` 继续作为路口几何的唯一 owner，但内部应从 `surfacePatches + laneConnectorPatches` 的并行推导，升级为共享同一组 connection curve / mouth trim。
4. sharp / near-parallel / 大角度转弯要有 join fallback，不能只依赖一条理想圆弧或一条固定 Bezier。

这能解释当前现象：大圆弧道路表现好，是因为它仍属于普通 road chain offset 问题；大转角、T/Y/X 路口表现差，是因为它们本质上是 junction connection surface 问题，不能只靠相邻 branch 的角区补片。

## RoadPen Current Baseline

当前 RoadPen 已经有自动派生的 `JunctionBlock`：

- `JunctionBlock` 类型包含 `mouthLines`、`surfacePatches`、`laneConnectorPatches`、`laneStops`、`virtualBoundary`，定义在 `src/geometry/junctionGeometry.ts`。
- `buildJunctionBlock()` 在同一 block 下生成 mouth、surface、lane connector 和 lane stop。
- renderer 会把 road segment polygons、junction patches、lane connector patches 放入 band bucket 后 union，见 `src/render/roadRenderer.ts`。
- SVG 已经给 mouth line 和 lane connector 输出 `data-junction-block-id`，见 `src/io/svgExport.ts`。

关键缺口：车行道面和外侧 lane connector 仍是分开推导的。它们都归属同一 `JunctionBlock`，但还没有共享同一个 directed connection 几何源，所以大转角时容易出现“lane 已经补圆角，但 road surface 没有对应 swept area”的空洞。

## SUMO Findings

SUMO 是最接近 RoadPen 问题域的参考。

相关源码：

- [`NBNode.cpp`](https://github.com/eclipse-sumo/sumo/blob/7cd06c9f399b0ca6fd8fe8bb75f495026ff20987/src/netbuild/NBNode.cpp#L587-L917)
- [`NBNodeShapeComputer.cpp`](https://github.com/eclipse-sumo/sumo/blob/7cd06c9f399b0ca6fd8fe8bb75f495026ff20987/src/netbuild/NBNodeShapeComputer.cpp#L123-L703)
- [`NBNode.h`](https://github.com/eclipse-sumo/sumo/blob/7cd06c9f399b0ca6fd8fe8bb75f495026ff20987/src/netbuild/NBNode.h)

可迁移点：

- SUMO 明确分开 junction shape 和 internal lane connection shape。`NBNodeShapeComputer::computeNodeShapeDefault()` 根据各 edge 的 CW/CCW boundary、相邻边界交点、半径、near-parallel 情况来生成 node/junction 边界。
- `NBNode::computeInternalLaneShape()` 是 lane-to-lane connection first：先取 from lane shape 与 to lane shape，再根据 direction 分类和 shape flag 生成内部连接线。
- `NBNode::computeSmoothShape()` / `bezierControlPoints()` 不是固定圆弧。它按角度分支处理 straight、S-curve、turn、turnaround，并在交点无效、控制长度过短、宽左转/宽右转时退化。
- `NBNodeShapeComputer::getSmoothCorner()` 会对 junction shape 的角点做平滑，但有 curvature 和角度检查。曲率过大时直接放弃可疑内角曲线。
- `computeEdgeBoundaries()` 会先拿 edge 的 CW/CCW 边界，截断、外推，再用于 junction shape 计算。这一点和 RoadPen 的 mouth trim / branch boundary 可以对应。

不适合直接迁移：

- SUMO 的 network builder、权限、right-of-way、turning direction、OpenDRIVE、rail/bike/pedestrian 特例过重，不应移植。
- SUMO 主要生成交通仿真网络，不是 canvas/SVG road surface renderer。RoadPen 只需要提炼 connection curve 与 swept polygon 的几何思想。

对 RoadPen 的含义：

- `JunctionBlock` 内应新增派生层 `JunctionConnection`，它比 `JunctionPatch` 更基础。
- 每条 connection 至少包含 `fromEdgeId`、`toEdgeId`、mouth 起终点、中心曲线、左右边界、swept polygon、turn class。
- `surfacePatches` 不再独立猜测角区，而是由所有 carriageway `JunctionConnection.sweptPolygon`、mouth patches、中心 virtual boundary union 得到。
- 外侧 lane connector 也应引用同一组 connection curve，只是使用不同 offset band 生成外侧 strip。

## MapLibre GL JS Findings

MapLibre 不做道路面级别建模，但它对 line join/cap 的数值稳定处理很有价值。

相关源码：

- [`line_bucket.ts`](https://github.com/maplibre/maplibre-gl-js/blob/5c78c3fc2170b34a337151585ec45ea1c026ae94/src/data/bucket/line_bucket.ts#L40-L62)
- [`line_bucket.ts`](https://github.com/maplibre/maplibre-gl-js/blob/5c78c3fc2170b34a337151585ec45ea1c026ae94/src/data/bucket/line_bucket.ts#L340-L520)

可迁移点：

- 它用 previous normal、next normal 的角平分线得到 join normal，再计算 `miterLength = 1 / cosHalfAngle`。
- sharp corner 会在角点前后增加额外顶点，避免锐角处渲染拉扯。
- join 类型不是静态的：round 可能退化到 miter/fakeround；miter 超过 limit 退化到 bevel；bevel 在超长 miter 时退化为 flipbevel。
- near-parallel / 180 度极端角被当作特殊数值分支处理，不让无限 miter 进入后续绘制。

不适合直接迁移：

- MapLibre 的实现面向 GPU tile line stroke，不产生道路面 polygon。
- dash、line distance buffer、shader vertex packing 与 RoadPen 无关。

对 RoadPen 的含义：

- 普通 road chain 的 offset join 可以引入类似的 `miterLimit -> bevel/round fallback`。
- 路口内不应直接套用 line stroke join；路口需要 connection swept area，而不是 stroke join。
- sharp corner 测试应覆盖 near-parallel、近 180 度、极短 segment，避免 polygon 自交和尖刺。

## OpenLayers Findings

OpenLayers 对本问题是低优先级参考。

相关源码：

- [`Stroke.js`](https://github.com/openlayers/openlayers/blob/a638a7004a2628438fb8c3180e3872e67404e2d7/src/ol/style/Stroke.js#L5-L17)
- [`canvas.js`](https://github.com/openlayers/openlayers/blob/a638a7004a2628438fb8c3180e3872e67404e2d7/src/ol/render/canvas.js#L96-L140)
- [`PolygonBuilder.js`](https://github.com/openlayers/openlayers/blob/a638a7004a2628438fb8c3180e3872e67404e2d7/src/ol/render/canvas/PolygonBuilder.js#L120-L130)

可迁移点：

- OpenLayers 公开的是 lineCap、lineJoin、miterLimit 这样的抽象配置，默认依赖 Canvas 的 round cap / round join。
- 它适合作为“简单 renderer 只配置 stroke 状态”的对照。

不适合迁移：

- 它不负责道路网络面生成，也没有 junction connection 建模。
- Canvas stroke join 的黑箱行为不适合作为 RoadPen 的几何真值。

对 RoadPen 的含义：

- RoadPen 可以保留 debug overlay 的 stroke join 配置，但 road surface 必须由显式 polygon 生成。

## Lanelet2 Findings

Lanelet2 不重点做渲染，但它的数据建模对内部车道很有参考价值。

相关源码：

- [`Lanelet.h`](https://github.com/fzi-forschungszentrum-informatik/Lanelet2/blob/62ef988b0a14487c69b07050d7aa0a787ff24ff3/lanelet2_core/include/lanelet2_core/primitives/Lanelet.h#L20-L216)
- [`Lanelet.cpp`](https://github.com/fzi-forschungszentrum-informatik/Lanelet2/blob/62ef988b0a14487c69b07050d7aa0a787ff24ff3/lanelet2_core/src/Lanelet.cpp#L180-L282)
- [`RoutingGraphBuilder.cpp`](https://github.com/fzi-forschungszentrum-informatik/Lanelet2/blob/62ef988b0a14487c69b07050d7aa0a787ff24ff3/lanelet2_routing/src/RoutingGraphBuilder.cpp#L124-L240)

可迁移点：

- Lanelet 以 left/right bounds 作为 lanelet 的核心数据，polygon 由左边界和反向右边界组成。
- centerline 是派生并缓存的，并且计算时要避免越出 polygon bounds。
- inverted lanelet 可以共享底层数据，只是翻转左右边界和方向。
- routing graph 使用 lanelet 的端点、邻接边界、overlap/conflict 来建立 successor、adjacent、conflicting 关系。

不适合直接迁移：

- Lanelet2 的 C++ geometry/routing/traffic rules 体系太重。
- RoadPen 当前还没有交通规则、转向限制、routing graph，不应提前引入。

对 RoadPen 的含义：

- 未来内部 lane 不应只存 centerline。更稳的模型是 bounds-first：lane surface = left/right boundary polygon，centerline 仅作为显示、编辑、routing 辅助。
- `JunctionConnection` 也应采用 bounds-first：中心曲线可用于采样，但最终判定 road fill 的是真实 swept polygon。

## RoadPen Design Recommendation

建议新增一个自动派生、非持久化的内部类型：

```ts
interface JunctionConnection {
  junctionBlockId: string;
  nodeId: string;
  fromEdgeId: string;
  toEdgeId: string;
  category: "carriageway" | "facility" | "sidewalk" | "clearance";
  turnClass: "straight" | "right" | "left" | "u" | "s-curve";
  passThrough: boolean;
  fromMouthPoint: Point;
  toMouthPoint: Point;
  centerCurve: Point[];
  leftBoundary: Point[];
  rightBoundary: Point[];
  sweptPolygon: Point[];
}
```

第一版不需要持久化它，也不需要 UI 暴露。它只作为 `JunctionBlock` 内部的派生几何源。

生成顺序建议：

1. `analyzeJunctionBranches()`：识别 branch、degree、pass-through、相邻角区。
2. `buildMouthLines()`：统一决定 road segment 在路口外的停止边界。
3. `buildDirectedJunctionConnections()`：对非 pass-through 的 directed branch pair 生成 carriageway connection；对外侧 lane 生成 facility/sidewalk/clearance connection。
4. `buildSurfaceFromConnections()`：`surfacePatches` 由 carriageway connection swept polygons + mouth patches + virtual boundary 组成。
5. `buildOuterLaneConnectorsFromConnections()`：外侧 lane connector 由同一 connection curve 和不同 offset band 派生。
6. renderer/export/debug 继续消费 `JunctionBlock`，但 debug 面板可按 connection 展示 `fromEdgeId -> toEdgeId`。

## Scenario Mapping

| 场景 | 推荐策略 | 说明 |
| --- | --- | --- |
| 普通大圆弧 road chain | centerline offset band | 当前模式基本正确。大圆弧能补齐，是因为问题仍是连续曲线的 band。 |
| T/Y/X 路口 | connection-based swept area | 由所有 directed connection 覆盖 turn swept area，mouth 决定道路段边界。 |
| 大转角右转 | directed right-turn connection | 不依赖骨架方向，双向道路要为两个方向都生成可能的 turn swept area。 |
| 斜向十字 | connection union + virtual boundary | 避免只用 convex hull，同时避免 connector 区被误填成 carriageway。 |
| sharp / near-parallel corner | miter/bevel/round fallback | 普通道路段使用 MapLibre 式阈值；路口内仍使用 connection。 |
| 内部车道 | bounds-first lane surface | 参考 Lanelet2，left/right bounds 是真值，centerline 派生。 |

## Next Implementation Plan

1. 在 `src/geometry/junctionGeometry.ts` 或新文件 `src/geometry/junctionConnections.ts` 中新增内部 `JunctionConnection` 派生层。
2. 把现有 `buildCarriagewayConnectorPatches()` 拆成两步：先生成 directed connection，再由 connection 输出 patch。
3. 让 `buildLaneConnectorPatches()` 复用 connection 的曲线/口门深度，避免 road surface 和 outer lane connector 各自计算停止点。
4. 普通道路段的 offset join 增加 `miterLimit`、`bevel`、`round`、`near-parallel` fallback。
5. SVG/debug 输出补充 `data-connection-id`、`data-from-edge-id`、`data-to-edge-id`、`data-turn-class`。

## Test Plan For Next Phase

- T 路口：非 pass-through 角区生成双向 directed connection，surface 覆盖右转 swept area。
- Y 路口：锐角分支不产生自交 polygon，connector 和 carriageway mouth 对齐。
- X 路口：四个有效角区生成 directed connection，斜向十字对角 probe points 被 carriageway union 覆盖。
- 大转角右转：白线标记的两个缺口由 connection swept polygon 覆盖。
- near-parallel：普通 road chain 退化为 bevel/round，不出现超长 miter 尖刺。
- SVG：同一 junction block 下所有 surface、connector、mouth、lane stop、connection debug path 带相同 `data-junction-block-id`。

## Bottom Line

RoadPen 下一步的关键不是继续增加孤立补片，而是把路口内“车行道补全”和“外侧 lane connector”统一到同一组 directed junction connections 上。这样 road surface 不再落后于 lane connector，当前大转角和对角小三角空洞会变成可测试、可定位、可调参的问题。
