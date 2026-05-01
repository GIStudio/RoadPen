如果我要顺手画一个道路剖面图呢？就是说除了马路本身，我还绘制平行的街道设施lane，以及人行lane，还有建筑净空lane。这几个lane的特点是在转弯的时候不参与道路面构成，但是参与转弯的一条连续的拐角构成。

===
可以，而且这其实比“只画马路面”更适合用**分层 offset / 分带 polygon**来做。

你现在的对象已经不是单一 road surface，而是一个**沿中心线展开的带状系统**：

* 车行道 band
* 街道设施 band
* 人行 band
* 建筑净空 band

它们在**直线段**上都是平行带；
在**转弯处**，它们不一定都并入“道路面”，但都要参与一个**连续的角部过渡**。

这类问题，最稳的表达不是“把所有东西都当作 road fill 的一部分”，而是：

> **把每一层 lane 都看成中心线的一个 signed offset band。**
> 转弯时，不是把它们合进车行道面，而是让每一层 band 在角部各自形成一个连续的 corner strip / annular sector。

---

# 1. 先统一对象：它不是一个 road polygon，而是一组 band

假设道路中心线是 (\gamma(s))，按弧长参数化。
单位切向量：

[
\mathbf{t}(s)=\frac{d\gamma}{ds}
]

单位法向量：

[
\mathbf{n}(s)=(-t_y(s),, t_x(s))
]

那么任意一个 offset 边界都可以写成：

[
\mathbf{B}_d(s)=\gamma(s)+d,\mathbf{n}(s)
]

这里 (d) 是**有符号偏移距离**：

* 左侧：(d>0)
* 右侧：(d<0)

---

## 1.1 定义累计 offset

比如你有：

* 车行道总宽 (w_r)
* 设施带宽 (w_f)
* 人行带宽 (w_p)
* 建筑净空带宽 (w_c)

则半幅车行道边界：

[
d_0=\frac{w_r}{2}
]

再向外累计：

[
d_1=d_0+w_f
]

[
d_2=d_1+w_p
]

[
d_3=d_2+w_c
]

于是左侧的几条边界是：

[
+d_0,\ +d_1,\ +d_2,\ +d_3
]

右侧则是：

[
-d_0,\ -d_1,\ -d_2,\ -d_3
]

那么各个 band 就是边界之间的区域：

* 左设施带：([d_0,d_1])
* 左人行带：([d_1,d_2])
* 左建筑净空带：([d_2,d_3])

右侧同理。

---

# 2. 直线段：就是平行 strip

如果一段中心线是线段 (\mathbf{p}_a \to \mathbf{p}_b)，单位方向：

[
\mathbf{u}=\frac{\mathbf{p}_b-\mathbf{p}_a}{|\mathbf{p}_b-\mathbf{p}_a|}
]

法向：

[
\mathbf{n}=(-u_y,u_x)
]

那么某个 band ([d_{\text{in}}, d_{\text{out}}]) 的 polygon 直接就是：

[
\mathbf{p}*a+d*{\text{in}}\mathbf{n},
\quad
\mathbf{p}*b+d*{\text{in}}\mathbf{n},
\quad
\mathbf{p}*b+d*{\text{out}}\mathbf{n},
\quad
\mathbf{p}*a+d*{\text{out}}\mathbf{n}
]

这部分很简单。

---

# 3. 难点在转弯：不要把外部 band 当成 road face 的延伸，而要把它们当成“角部带”

你说得很对：

> 设施 lane / 人行 lane / 建筑净空 lane
> 在转弯时不参与道路面构成，
> 但参与一条连续的拐角构成。

这在几何上其实就是：

* 车行道是一个 core band
* 设施、人行、净空是外侧 band
* 在 corner 位置，这些 band 形成**同心或近似同心的连续角带**

所以，转弯处的正确处理不是“单独给每个 band 随便放控制点”，而是：

> **先确定一个基础转弯几何（turn skeleton / turn radius），再让每个 offset band 从这个基础几何派生。**

---

# 4. degree=2 的普通折点：用“同心转角带”最合适

假设中心线在 (\mathbf{p}_1) 转弯，前后点为 (\mathbf{p}_0,\mathbf{p}_2)。

进入方向：

[
\mathbf{u}=
\frac{\mathbf{p}_1-\mathbf{p}_0}
{|\mathbf{p}_1-\mathbf{p}_0|}
]

离开方向：

[
\mathbf{v}=
\frac{\mathbf{p}_2-\mathbf{p}_1}
{|\mathbf{p}_2-\mathbf{p}_1|}
]

转角：

[
\delta=\arccos(\mathbf{u}\cdot\mathbf{v})
]

转向符号：

[
\sigma=\operatorname{sign}(u_xv_y-u_yv_x)
]

其中：

* (\sigma=+1)：左转
* (\sigma=-1)：右转

---

## 4.1 先给中心线定义一个基础转弯半径

设中心线转弯半径为：

[
r_c
]

通常你可以取：

[
r_c = k \cdot \frac{w_r}{2}
\quad\text{或}\quad
r_c = k \cdot w_r
]

(k) 可以是 1.5、2、3 等。

然后中心线 tangency length 为：

[
\ell_c = r_c \tan\frac{\delta}{2}
]

对应中心线转弯起止点：

[
\mathbf{a}_c = \mathbf{p}_1 - \ell_c \mathbf{u}
]

[
\mathbf{b}_c = \mathbf{p}_1 + \ell_c \mathbf{v}
]

圆心可写成：

[
\mathbf{O}
==========

# \mathbf{a}_c + \sigma r_c \mathbf{n}_u

\mathbf{b}_c + \sigma r_c \mathbf{n}_v
]

其中：

[
\mathbf{n}_u=(-u_y,u_x),\quad \mathbf{n}_v=(-v_y,v_x)
]

这个 (\mathbf{O}) 是整个 corner 的参考中心。

---

# 5. 外部 lane 的关键：它们是这个基础转角的 offset band

对于任意一条 signed offset 边界 (d)，它在转弯处的半径不是随便设，而是由基础转弯派生：

[
r(d)=r_c-\sigma d
]

这个公式很重要。

---

## 5.1 直觉解释

假设是左转 ((\sigma=+1))：

* 左侧 band 是内侧，半径变小：
  [
  r(d)=r_c-d
  ]
* 右侧 band 是外侧，半径变大：
  [
  r(d)=r_c-(-d)=r_c+|d|
  ]

这正符合几何直觉。

---

## 5.2 每条边界的切点也随之变化

边界 (d) 的切线长度：

[
\ell(d)=r(d)\tan\frac{\delta}{2}
]

边界转弯起止点：

[
\mathbf{a}(d)=\mathbf{p}_1-\ell(d)\mathbf{u}
]

[
\mathbf{b}(d)=\mathbf{p}_1+\ell(d)\mathbf{v}
]

所以你会得到一组**嵌套的边界曲线**：

* 车行道边界
* 设施带外边界
* 人行带外边界
* 建筑净空外边界

这些边界天然就是连续的带状角部。

---

# 6. 因此，每个 lane 不再是“独立转弯”，而是“两个边界之间的一块角带”

例如左侧人行带，对应边界：

* 内边界：(d_1)
* 外边界：(d_2)

那么它在转弯处对应的区域，就是：

[
\mathcal{L}_{\text{ped,left}}
=============================

\text{sector between } r(d_1) \text{ and } r(d_2)
]

更准确地说，是一个**环扇形带**（annular sector）。

所以你的设施带、人行带、净空带，全部都可以统一为：

> **“两个 offset 边界之间的 corner strip”**

而不是参与 road face 的 fill union。

---

# 7. 这时最推荐的表示方式是：每个边界是一条 curve，每个 lane 是两条 curve 之间的 fill

也就是：

* 先为每条边界生成 curve
* 再把相邻边界拼成 band polygon

这比“直接画 lane 本体”稳得多。

---

## 7.1 边界 curve 可以是精确圆弧，也可以是 Bézier 近似

如果你想继续沿用 Bézier，那么对于半径 (r(d)) 的边界曲线，可以用三次 Bézier 逼近圆弧：

控制柄长度：

[
h(d)=\frac{4}{3}r(d)\tan\frac{\delta}{4}
]

控制点：

[
\mathbf{c}_0(d)=\mathbf{a}(d)
]

[
\mathbf{c}_1(d)=\mathbf{a}(d)+h(d)\mathbf{u}
]

[
\mathbf{c}_2(d)=\mathbf{b}(d)-h(d)\mathbf{v}
]

[
\mathbf{c}_3(d)=\mathbf{b}(d)
]

于是边界 curve 为：

[
\mathbf{C}_d(t)
===============

(1-t)^3\mathbf{c}_0
+3(1-t)^2t\mathbf{c}_1
+3(1-t)t^2\mathbf{c}_2
+t^3\mathbf{c}_3
]

---

## 7.2 某个 lane 的角部 polygon

假设 lane 由内外两条边界 (d_{\text{in}}, d_{\text{out}}) 组成，则角部 polygon 可以写成：

1. 沿 (\mathbf{C}*{d*{\text{in}}}) 从起点走到终点
2. 连到 (\mathbf{C}*{d*{\text{out}}}) 的终点
3. 沿 (\mathbf{C}*{d*{\text{out}}}) 反向走回起点
4. 闭合

也就是：

[
[
\mathbf{C}*{d*{\text{in}}}(0\to1),
\mathbf{C}*{d*{\text{out}}}(1\to0)
]
]

再和前后的直线 strip 拼接起来。

---

# 8. 一个特别重要的建模思想：用“边界层”而不是“功能层”来组织

如果你直接存：

* road lane
* facility lane
* sidewalk lane
* clearance lane

会比较难处理 corner。

更好的方式是存 **boundary stack**：

[
\mathcal{D}_{\text{left}} = [0, d_0, d_1, d_2, d_3]
]

[
\mathcal{D}_{\text{right}} = [0, -d_0, -d_1, -d_2, -d_3]
]

然后 band 是相邻边界之间的“标签区间”：

* ([0,d_0])：车行半幅
* ([d_0,d_1])：设施带
* ([d_1,d_2])：人行带
* ([d_2,d_3])：建筑净空带

这样：

* 直线段：每条 boundary offset 一次
* 转弯段：每条 boundary 生成一条转角 curve
* 最终 polygon：相邻 boundary 拼接

这个数据结构最清晰。

---

# 9. 和“道路面”分离的实现方式

你提到：

> 这些 lane 在转弯的时候不参与道路面构成

那就说明最终输出不要只是一整个 union polygon，而应该是**多个语义 band polygon**：

* road_surface_polygon
* facility_band_polygon
* sidewalk_band_polygon
* clearance_band_polygon

这样你后续还能做：

* 不同材质填充
* 路缘石 / 树池 / 路灯 / 栏杆附着
* 人行带与建筑退界之间的对象布置
* 独立导出到 mesh / SVG / GIS polygon layer

这比把它们一股脑 union 到 road polygon 里更适合你的系统。

---

# 10. 几何上需要注意的约束

## 10.1 内侧半径不能塌陷

对任意边界 (d)，要保证：

[
r(d) > 0
]

否则内侧 curve 会翻转或自交。

所以，如果某个转弯非常急，而你外部 band 又很多，那么基础中心线半径 (r_c) 必须足够大：

[
r_c > \max_{\text{inner side}} |d|
]

如果不满足，就要：

* 增大 (r_c)
* 或缩减角部带宽
* 或退化成 chamfer
* 或在极端情况下直接截断，不画连续圆角

---

## 10.2 短边段要 clamp

如果前后线段太短，则：

[
\ell(d)=r(d)\tan\frac{\delta}{2}
]

可能超过线段长度。

所以需要：

[
\ell(d)
\le
\alpha \min(|\mathbf{p}_1-\mathbf{p}_0|,|\mathbf{p}_2-\mathbf{p}_1|)
]

一般可以取：

[
\alpha = 0.4 \sim 0.45
]

---

# 11. 如果是交叉口，不要沿用普通 degree=2 转弯逻辑

如果节点度数 (\ge 3)，你就不是在处理一个普通弯道，而是在处理一个**junction patch**。

这时更合理的方式是：

1. 每条 incoming / outgoing road 先生成自己的 boundary stack
2. 在交叉口附近截断
3. 对每一对相邻 arm，生成一个 corner cell
4. 每个 corner cell 内再分出：

   * 车行道区
   * 设施带区
   * 人行带区
   * 净空带区
5. 用这些 cell 拼出整个交叉口

也就是说，交叉口里不是“一条道路的转弯”，而是“一组 banded corner wedge”。

这和你之前说的人行道转角连续，实际上是同一问题。

---

# 12. 你这个需求，最适合的统一表达

我建议你把整个系统写成这个形式：

---

## 12.1 几何骨架层

输入：

* 中心线 graph / polyline
* 每段属性：车行宽度、设施带宽、人行带宽、净空带宽
* 每个节点属性：是否平滑转弯、转弯半径、junction 类型

---

## 12.2 边界生成层

对每个 side，生成累计边界：

[
D_{\text{side}}=[d_0,d_1,d_2,d_3,\dots]
]

每条边界在：

* 直线段上：offset line
* 弯道段上：offset turn curve
* 交叉口上：junction boundary arc / patch edge

---

## 12.3 band 组装层

对相邻边界 ((d_i,d_{i+1}))，生成 band polygon：

[
\mathcal{L}*i = \text{region between } B*{d_i} \text{ and } B_{d_{i+1}}
]

并赋予语义：

* carriageway
* furniture
* sidewalk
* clearance

---

## 12.4 渲染层

分别渲染：

* road surface fill
* sidewalk fill
* curb line
* building setback line
* 街道设施放置基线

---

# 13. 一个很实用的 Python 数据结构

```python
from dataclasses import dataclass

@dataclass
class BandSpec:
    name: str
    width: float
    color: str = ""
    participates_in_road_surface: bool = False
    rounded_corner: bool = True

ROAD_STACK = [
    BandSpec("carriageway_half", width=3.5, participates_in_road_surface=True),
    BandSpec("furniture", width=1.5),
    BandSpec("sidewalk", width=2.5),
    BandSpec("building_clearance", width=1.0),
]
```

然后累计 offset：

```python
def cumulative_offsets(bands):
    offsets = [0.0]
    s = 0.0
    for b in bands:
        s += b.width
        offsets.append(s)
    return offsets
```

左侧直接用正值，右侧用负值。

---

# 14. 最核心的结论

你这个需求，最好的建模方式不是：

> “道路面 + 若干附属 lane”

而是：

> **“以中心线为骨架的一组分层 offset band”**

然后：

* 直线段：band = 平行 strip
* 普通转弯：band = 两条 offset curve 之间的连续角带
* 交叉口：band = 多个 corner wedge / junction patch 的组合

---

# 15. 一句话总结成公式

如果你想把整个东西形式化，最简洁的表达是：

对中心线 (\gamma(s))，定义有符号边界集合 ({d_i})。
每个功能带 (i) 对应区域：

[
\mathcal{L}_i
=============

\left{
\gamma(s)+\lambda \mathbf{n}(s)
;\middle|;
s\in[0,L],,
\lambda\in[d_i,d_{i+1}]
\right}
]

在折点处，(\gamma(s)) 不是直接折断，而是替换为一段平滑转角曲线 (\gamma_{\text{turn}}(s))；
于是所有 lane 都自动形成连续的 corner band。

---

如果你愿意，我下一步可以直接继续给你两样东西中的一个：

1. **一个可直接实现的 Python 几何代码版本**
   （输入 polyline + 各 band 宽度，输出每个 band 的 polygon）

2. **一个更适合你现在道路生成系统的数据结构 / pipeline 设计图**
   （centerline → boundary stack → corner patch → band polygons）

如果你要，我建议我直接给你 **Python 实现骨架**。


可以把你的问题抽象成一个更清晰的几何模型：

> **道路中心线不是只生成“马路面”，而是 sweep 一个横断面模板。**
> 马路、街道设施 lane、人行 lane、建筑净空 lane 都是中心线两侧的不同 offset band。
> 转弯时，每个 band 都用自己的内外边界曲线闭合，但只有马路 band 进入 `road_surface`。

---

# 1. 核心逻辑

设道路中心线为：

[
\mathbf c(t)
]

道路中心线左侧为正 offset，右侧为负 offset。

假设机动车道路半宽为：

[
h
]

那么马路面是：

[
q \in [-h, h]
]

左侧设施、人行、建筑净空可以定义为：

[
[h, h+w_f]
]

[
[h+w_f, h+w_f+w_p]
]

[
[h+w_f+w_p, h+w_f+w_p+w_c]
]

右侧类似，只是 offset 为负：

[
[-h, -h-w_f]
]

[
[-h-w_f, -h-w_f-w_p]
]

[
[-h-w_f-w_p, -h-w_f-w_p-w_c]
]

所以，每一个 lane 都是一个 **offset interval**：

[
B_j = [q_{j,\text{inner}}, q_{j,\text{outer}}]
]

然后它的 polygon 就是：

[
\Omega_j =
\text{polygon}
\left(
\gamma_{q_\text{outer}}(t),
\gamma_{q_\text{inner}}(t)^\text{reverse}
\right)
]

其中：

[
\gamma_q(t)=\mathbf c(t)+q\mathbf n(t)
]

(\mathbf n(t)) 是中心线法向量。

---

# 2. 转弯处的关键点

你不应该让设施 lane、人行 lane、建筑净空 lane 参与马路面的 union。

而是应该这样：

```text
road_surface
  = band[-road_half_width, +road_half_width]

facility_lane
  = band[road_half_width, road_half_width + facility_width]

sidewalk_lane
  = band[road_half_width + facility_width,
         road_half_width + facility_width + sidewalk_width]

clearance_lane
  = band[road_half_width + facility_width + sidewalk_width,
         road_half_width + facility_width + sidewalk_width + clearance_width]
```

这些 polygon 是并列图层，不是一个大 polygon。

也就是说：

```text
马路转弯 polygon      只由 road band 构成
设施 lane 转弯 polygon  由 facility band 构成
人行 lane 转弯 polygon  由 sidewalk band 构成
净空 lane 转弯 polygon  由 clearance band 构成
```

但是它们共享同一条中心线和同一个转弯几何，因此视觉上会形成连续的街道拐角。

---

# 3. 转弯处的 offset Bézier

对于一个转弯点：

[
\mathbf p_0,\mathbf p_1,\mathbf p_2
]

进入方向：

[
\mathbf u=\frac{\mathbf p_1-\mathbf p_0}{|\mathbf p_1-\mathbf p_0|}
]

离开方向：

[
\mathbf v=\frac{\mathbf p_2-\mathbf p_1}{|\mathbf p_2-\mathbf p_1|}
]

转角：

[
\delta=\arccos(\mathbf u\cdot \mathbf v)
]

转向符号：

[
\sigma=\operatorname{sign}(u_xv_y-u_yv_x)
]

其中：

```text
sigma = +1  左转
sigma = -1  右转
```

中心线转弯半径为 (R)。

对于任意 signed offset (q)，对应边界的转弯半径是：

[
R_q = R - \sigma q
]

这条公式很重要。

例如左转时，左侧 offset 为正，所以左侧是内弯：

[
R_q = R - q
]

如果左侧 lane 太宽，而中心线半径太小，就会出现：

[
R_q \leq 0
]

这说明内侧 lane 在转弯处坍缩了。解决方式不是强行 fill，而是：

```text
增大转弯半径
减少 lane 总宽度
合并过短的骨架线段
降低转弯平滑程度
```

---

# 4. 每个 lane 的转弯 polygon

对于某个 lane：

[
[q_0,q_1]
]

其中 (q_0) 是内边界，(q_1) 是外边界。

在转弯处分别生成两条 offset Bézier：

[
B_{q_0}(t)
]

[
B_{q_1}(t)
]

然后 lane 的转弯 polygon 是：

```text
outer boundary: B_q1(0 -> 1)
inner boundary: B_q0(1 -> 0)
fill
```

也就是：

[
\Omega_{\text{lane}}
====================

[
B_{q_1}(0),
B_{q_1}(1),
B_{q_0}(1),
B_{q_0}(0)
]
]

采样后就是一个普通 polygon。

---

# 5. 完整 Python 实现

下面这段代码做的是：

```text
输入：
  1. 道路中心线 polyline
  2. 道路半宽
  3. 左右两侧的 lane 模板

输出：
  每个图层的 polygon：
    road
    left_facility
    left_sidewalk
    left_clearance
    right_facility
    right_sidewalk
    right_clearance
```

不依赖 Shapely，只用 NumPy。

```python
import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np


def unit(v, eps=1e-12):
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    if n < eps:
        raise ValueError("Zero-length vector.")
    return v / n


def left_normal(d):
    return np.array([-d[1], d[0]], dtype=float)


def cross2(a, b):
    return float(a[0] * b[1] - a[1] * b[0])


def cubic_bezier_points(p0, p1, p2, p3, samples=24):
    t = np.linspace(0.0, 1.0, samples)
    return (
        ((1 - t) ** 3)[:, None] * p0
        + (3 * (1 - t) ** 2 * t)[:, None] * p1
        + (3 * (1 - t) * t ** 2)[:, None] * p2
        + (t ** 3)[:, None] * p3
    )


def line_intersection(p, d, q, e, eps=1e-9):
    """
    Solve:
        p + t d = q + s e
    """
    den = cross2(d, e)
    if abs(den) < eps:
        return None

    t = cross2(q - p, e) / den
    return p + t * d


@dataclass
class LaneBand:
    name: str
    side: str
    q_inner: float
    q_outer: float
    role: str = "lane"


@dataclass
class TurnSpec:
    idx: int
    u: np.ndarray
    v: np.ndarray
    a: np.ndarray
    b: np.ndarray
    delta: float
    sigma: float
    radius: float
    ell: float
    warning: Optional[str] = None


@dataclass
class StreetProfile:
    road_half_width: float
    left_lanes: List[Tuple[str, float]]
    right_lanes: List[Tuple[str, float]]

    def bands(self) -> List[LaneBand]:
        bands = []

        h = self.road_half_width

        # 马路本身：中心 band
        bands.append(
            LaneBand(
                name="road",
                side="center",
                q_inner=-h,
                q_outer=+h,
                role="road",
            )
        )

        # 左侧外部 lane
        q = h
        for name, width in self.left_lanes:
            bands.append(
                LaneBand(
                    name=f"left_{name}",
                    side="left",
                    q_inner=q,
                    q_outer=q + width,
                    role=name,
                )
            )
            q += width

        # 右侧外部 lane
        q = -h
        for name, width in self.right_lanes:
            bands.append(
                LaneBand(
                    name=f"right_{name}",
                    side="right",
                    q_inner=q,
                    q_outer=q - width,
                    role=name,
                )
            )
            q -= width

        return bands

    @property
    def max_left_offset(self) -> float:
        return self.road_half_width + sum(w for _, w in self.left_lanes)

    @property
    def max_right_offset(self) -> float:
        return self.road_half_width + sum(w for _, w in self.right_lanes)
```

---

# 6. 预计算每个转弯点

这里会判断哪些点需要转弯平滑。

同时要检查一个重要条件：

```text
中心线转弯半径必须大于内侧最大 offset
```

否则设施 lane、人行 lane、建筑净空 lane 在内弯处会坍缩。

```python
def prepare_turns(
    polyline,
    profile: StreetProfile,
    radius_factor=1.8,
    angle_threshold_deg=3.0,
    clamp_ratio=0.45,
    min_inner_radius=0.25,
) -> Dict[int, Optional[TurnSpec]]:
    """
    为 polyline 中的每个内部点准备转弯信息。

    radius_factor:
        中心线转弯半径约等于 radius_factor * road_width。

    clamp_ratio:
        转弯切入距离不能超过前后线段长度的一定比例，
        防止相邻转弯互相重叠。
    """
    P = np.asarray(polyline, dtype=float)

    if len(P) < 2:
        raise ValueError("Polyline must contain at least two points.")

    turns: Dict[int, Optional[TurnSpec]] = {}

    road_width = 2.0 * profile.road_half_width
    base_radius = radius_factor * road_width
    angle_threshold = math.radians(angle_threshold_deg)

    for i in range(1, len(P) - 1):
        prev_len = np.linalg.norm(P[i] - P[i - 1])
        next_len = np.linalg.norm(P[i + 1] - P[i])

        u = unit(P[i] - P[i - 1])
        v = unit(P[i + 1] - P[i])

        dot = np.clip(float(np.dot(u, v)), -1.0, 1.0)
        delta = math.acos(dot)
        cr = cross2(u, v)

        # 近似直线，不做圆角
        if delta < angle_threshold or abs(cr) < 1e-9:
            turns[i] = None
            continue

        sigma = 1.0 if cr > 0 else -1.0

        # 左转时，左侧是内弯；右转时，右侧是内弯
        inside_offset = (
            profile.max_left_offset
            if sigma > 0
            else profile.max_right_offset
        )

        desired_radius = max(
            base_radius,
            inside_offset + min_inner_radius,
        )

        ell_desired = desired_radius * math.tan(delta / 2.0)

        ell = min(
            ell_desired,
            clamp_ratio * prev_len,
            clamp_ratio * next_len,
        )

        if ell <= 1e-9:
            turns[i] = None
            continue

        radius_eff = ell / math.tan(delta / 2.0)

        a = P[i] - ell * u
        b = P[i] + ell * v

        warning = None
        if radius_eff <= inside_offset:
            warning = (
                f"Turn {i}: inner lane may collapse. "
                f"effective radius={radius_eff:.3f}, "
                f"inside offset={inside_offset:.3f}. "
                f"Increase radius_factor, simplify skeleton, "
                f"or reduce lane width."
            )

        turns[i] = TurnSpec(
            idx=i,
            u=u,
            v=v,
            a=a,
            b=b,
            delta=delta,
            sigma=sigma,
            radius=radius_eff,
            ell=ell,
            warning=warning,
        )

    return turns
```

---

# 7. 任意 offset 边界的转弯 Bézier

这里是核心。

对于某个 signed offset (q)，生成对应边界的转弯曲线。

```python
def offset_turn_curve(turn: TurnSpec, q: float, samples=24) -> np.ndarray:
    """
    q:
        signed offset from centerline.
        left side is positive.
        right side is negative.
    """
    rq = turn.radius - turn.sigma * q

    if rq <= 1e-6:
        raise ValueError(
            f"Offset q={q:.3f} collapses at turn {turn.idx}. "
            f"offset radius={rq:.3f}. "
            f"Increase turn radius or reduce lane width."
        )

    n_in = left_normal(turn.u)
    n_out = left_normal(turn.v)

    p0 = turn.a + q * n_in
    p3 = turn.b + q * n_out

    h = (4.0 / 3.0) * rq * math.tan(turn.delta / 4.0)

    p1 = p0 + h * turn.u
    p2 = p3 - h * turn.v

    return cubic_bezier_points(p0, p1, p2, p3, samples)
```

---

# 8. 生成一条完整 offset boundary

一条 lane polygon 需要两条 offset boundary。

比如左侧人行 lane：

```text
inner boundary: q = road_half_width + facility_width
outer boundary: q = road_half_width + facility_width + sidewalk_width
```

下面的函数会沿整条 polyline 生成某个 (q) 的完整 offset path。

```python
def offset_boundary_path(
    polyline,
    turns: Dict[int, Optional[TurnSpec]],
    q: float,
    samples_per_turn=24,
) -> np.ndarray:
    P = np.asarray(polyline, dtype=float)

    dirs = [
        unit(P[i + 1] - P[i])
        for i in range(len(P) - 1)
    ]

    norms = [
        left_normal(d)
        for d in dirs
    ]

    pts = []

    # 起点 offset
    pts.append(P[0] + q * norms[0])

    for i in range(1, len(P) - 1):
        turn = turns.get(i)

        if turn is not None:
            curve = offset_turn_curve(
                turn,
                q=q,
                samples=samples_per_turn,
            )

            # 前一段直线会自动连接到 curve[0]
            pts.append(curve[0])
            pts.extend(curve[1:])

        else:
            # 不做圆角时，用 offset line 的交点作为 miter join
            p_line = P[i] + q * norms[i - 1]
            q_line = P[i] + q * norms[i]

            m = line_intersection(
                p_line,
                dirs[i - 1],
                q_line,
                dirs[i],
            )

            if m is None:
                # 近似平行时，使用平均法向
                avg_n = unit(norms[i - 1] + norms[i])
                m = P[i] + q * avg_n

            pts.append(m)

    # 终点 offset
    pts.append(P[-1] + q * norms[-1])

    return np.vstack(pts)
```

---

# 9. 由两条 boundary 生成 lane polygon

```python
def make_band_polygon(
    polyline,
    turns,
    band: LaneBand,
    samples_per_turn=24,
) -> np.ndarray:
    outer_path = offset_boundary_path(
        polyline,
        turns,
        q=band.q_outer,
        samples_per_turn=samples_per_turn,
    )

    inner_path = offset_boundary_path(
        polyline,
        turns,
        q=band.q_inner,
        samples_per_turn=samples_per_turn,
    )

    polygon = np.vstack([
        outer_path,
        inner_path[::-1],
    ])

    return polygon
```

---

# 10. 总入口：生成所有道路剖面 lane

```python
def build_street_polygons(
    polyline,
    profile: StreetProfile,
    radius_factor=1.8,
    samples_per_turn=24,
    angle_threshold_deg=3.0,
    clamp_ratio=0.45,
):
    turns = prepare_turns(
        polyline,
        profile=profile,
        radius_factor=radius_factor,
        angle_threshold_deg=angle_threshold_deg,
        clamp_ratio=clamp_ratio,
    )

    warnings = [
        t.warning
        for t in turns.values()
        if t is not None and t.warning is not None
    ]

    polygons = {}

    for band in profile.bands():
        polygons[band.name] = make_band_polygon(
            polyline,
            turns,
            band,
            samples_per_turn=samples_per_turn,
        )

    return polygons, warnings
```

---

# 11. 使用示例

```python
polyline = [
    (0.0, 0.0),
    (50.0, 0.0),
    (50.0, 50.0),
    (90.0, 50.0),
]

profile = StreetProfile(
    road_half_width=3.5,

    left_lanes=[
        ("facility", 1.5),
        ("sidewalk", 3.0),
        ("clearance", 2.0),
    ],

    right_lanes=[
        ("facility", 1.0),
        ("sidewalk", 2.5),
        ("clearance", 1.5),
    ],
)

polygons, warnings = build_street_polygons(
    polyline,
    profile,
    radius_factor=2.2,
    samples_per_turn=32,
)

for w in warnings:
    print(w)

road_polygon = polygons["road"]

external_lane_polygons = {
    name: poly
    for name, poly in polygons.items()
    if name != "road"
}
```

这时：

```python
polygons["road"]
```

只表示马路面。

而：

```python
polygons["left_facility"]
polygons["left_sidewalk"]
polygons["left_clearance"]
polygons["right_facility"]
polygons["right_sidewalk"]
polygons["right_clearance"]
```

都是独立的外部 lane 图层。

它们不会被合并进 `road_polygon`。

---

# 12. 可视化检查

```python
import matplotlib.pyplot as plt

plt.figure(figsize=(8, 8))

for name, poly in polygons.items():
    plt.fill(
        poly[:, 0],
        poly[:, 1],
        alpha=0.35,
        label=name,
    )

P = np.asarray(polyline)
plt.plot(P[:, 0], P[:, 1], marker="o", linewidth=1.5, label="centerline")

plt.axis("equal")
plt.legend()
plt.show()
```

---

# 13. 这个模型对应的绘制逻辑

你可以把绘制系统分成三层：

```text
1. skeleton layer
   输入道路中心线 polyline / graph

2. section template layer
   定义横断面 lane：
   road
   facility
   sidewalk
   clearance

3. surface generation layer
   对每个 lane band 生成 polygon
```

其中最关键的是：

```text
每个 lane 都不是单独找控制点。
每个 lane 都是同一个中心线转弯的 signed offset。
```

这样可以保证：

```text
road 和 facility 共享同一条 curb boundary
facility 和 sidewalk 共享同一条 boundary
sidewalk 和 clearance 共享同一条 boundary
所有 lane 在转弯处连续
所有 lane 的宽度稳定
road surface 不会被外部 lane 污染
```

---

# 14. 对你的原始想法的修正

你原来的逻辑大概是：

```text
骨架中心线
-> 判断能否转弯
-> 设道路宽度
-> 从端点向内找道路宽度点
-> 控制点计算 Bézier
-> fill
```

现在建议改成：

```text
骨架中心线
-> 根据转角决定是否生成中心线转弯
-> 根据最大 lane offset 决定中心线转弯半径
-> 每一个 signed offset q 生成一条 offset Bézier boundary
-> 每个 lane 用两条 boundary 闭合成 polygon
-> road polygon 和外部 lane polygon 分层存储
-> 最后分别 fill
```

也就是：

```text
不是“道路面 + 附属设施”
而是“中心线 sweep 一个道路横断面模板”
```

---

# 15. 交叉口需要单独处理

上面的代码适合这种情况：

```text
A ---- B
       |
       C
```

也就是 degree = 2 的普通转弯点。

如果是 T 字路口或十字路口：

```text
    C
    |
A---B---D
```

不要把它当作多个普通转弯。

交叉口应该单独生成 node patch：

```text
road node patch:
    只包含 road band 的交叉口面

facility / sidewalk / clearance:
    在 road node patch 外侧形成独立的 corner ring 或 sidewalk corner patch
```

概念上是：

[
\Omega_{\text{road}}
====================

\bigcup \text{road edge strips}
\cup
\text{road intersection patch}
]

而外部 lane 是：

[
\Omega_{\text{sidewalk}}
========================

\bigcup \text{sidewalk edge strips}
\cup
\text{sidewalk corner patches}
]

不要把 sidewalk、clearance 直接 union 到 road intersection patch 里面。

---

# 16. 最简结论

你的需求应该实现成：

```text
centerline
  -> smoothed turns
  -> signed offset boundaries
  -> band polygons
  -> layered fill
```

其中：

```text
road:
  q = [-h, +h]

facility lane:
  q = [h, h + w_facility]

sidewalk lane:
  q = [h + w_facility,
       h + w_facility + w_sidewalk]

building clearance lane:
  q = [h + w_facility + w_sidewalk,
       h + w_facility + w_sidewalk + w_clearance]
```

转弯时每个 lane 都使用：

[
R_q = R - \sigma q
]

这就是保证它们在转弯处连续、同心、可填充，同时又不参与马路面构成的关键。
