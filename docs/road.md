道路面如何绘制？尤其是通过贝塞尔曲线，如何绘制转弯？我设想是通过一个骨架，绘制最基本的道路中心线，然后设定一个阈值，超过这个阈值的可以转弯，设定第二个值就是道路的宽度，然后从端点向内寻找道路宽度的点，这个点作为转弯的绘制起点，在骨架以及宽度对应的道路边界上，有一个控制点，来计算贝塞尔曲线。转弯全部都用填充计算。

===
你的思路是对的：**先画道路骨架中心线，再根据宽度生成道路面，最后用填充得到路面 polygon**。但有一个关键改进：

> 不建议直接在道路边界上手工放控制点。
> 更稳健的做法是：**先把中心线拐弯平滑成 Bézier 曲线，再从这条中心曲线生成左右边界，最后填充闭合区域。**

也就是说，核心流程应该是：

[
\text{centerline skeleton}
\rightarrow
\text{smoothed center curve}
\rightarrow
\text{left/right offset boundary}
\rightarrow
\text{closed polygon fill}
]

---

## 1. 把道路看成中心线的 buffer

如果道路中心线是：

[
\mathbf{c}(t)
]

道路宽度是：

[
w
]

那么道路左、右边界可以写成：

[
\mathbf{L}(t)=\mathbf{c}(t)+\frac{w}{2}\mathbf{n}(t)
]

[
\mathbf{R}(t)=\mathbf{c}(t)-\frac{w}{2}\mathbf{n}(t)
]

其中 (\mathbf{n}(t)) 是中心线在 (t) 处的单位法向量：

[
\mathbf{n}(t)=\frac{(-c_y'(t), c_x'(t))}{|\mathbf{c}'(t)|}
]

所以，道路面本质上是中心线的一个**带宽区域**，也就是几何上的 buffer。

---

## 2. 单个转弯点的 Bézier 构造

假设道路中心线经过三个点：

[
\mathbf{p}_0,\mathbf{p}_1,\mathbf{p}_2
]

其中 (\mathbf{p}_1) 是转弯点。

定义进入方向和离开方向：

[
\mathbf{u}=
\frac{\mathbf{p}_1-\mathbf{p}_0}
{|\mathbf{p}_1-\mathbf{p}_0|}
]

[
\mathbf{v}=
\frac{\mathbf{p}_2-\mathbf{p}_1}
{|\mathbf{p}_2-\mathbf{p}_1|}
]

转角为：

[
\delta=\arccos(\mathbf{u}\cdot \mathbf{v})
]

如果：

[
\delta < \delta_{\min}
]

就认为这个点几乎是直线，不需要绘制转弯。

如果：

[
\delta \geq \delta_{\min}
]

则在 (\mathbf{p}_1) 两侧各截取一段，作为 Bézier 曲线的起点和终点。

---

## 3. 转弯起点不一定应该等于道路宽度

你说的“从端点向内寻找道路宽度的点，作为转弯绘制起点”可以作为初始方案，但严格来说，**转弯起点距离最好由转弯半径决定，而不是直接等于道路宽度**。

设转弯半径为：

[
r = k w
]

其中 (k) 是控制转弯圆滑程度的系数。比如：

[
k=1.5, 2, 3
]

然后转弯前后截断距离为：

[
\ell = r \tan\frac{\delta}{2}
]

为了避免短边上转弯区域重叠，需要 clamp：

[
\ell =
\min
\left(
r \tan\frac{\delta}{2},
\alpha |\mathbf{p}_1-\mathbf{p}_0|,
\alpha |\mathbf{p}_2-\mathbf{p}_1|
\right)
]

其中通常可以取：

[
\alpha = 0.4 \sim 0.5
]

然后转弯 Bézier 的起点和终点是：

[
\mathbf{a}=\mathbf{p}_1-\ell \mathbf{u}
]

[
\mathbf{b}=\mathbf{p}_1+\ell \mathbf{v}
]

---

## 4. 二次 Bézier：最简单方案

最简单的转弯曲线可以用二次 Bézier：

[
\mathbf{c}(t)
=============

(1-t)^2\mathbf{a}
+
2(1-t)t\mathbf{p}_1
+
t^2\mathbf{b}
]

其中：

[
t\in[0,1]
]

也就是：

* 起点：(\mathbf{a})
* 控制点：(\mathbf{p}_1)
* 终点：(\mathbf{b})

这个方案非常简单，而且切线方向是对的：

[
\mathbf{c}'(0) \parallel \mathbf{u}
]

[
\mathbf{c}'(1) \parallel \mathbf{v}
]

也就是说，曲线会自然接入前后两条道路中心线。

缺点是：二次 Bézier 不是严格圆弧，转弯半径不恒定，但作为视觉渲染通常已经够用。

---

## 5. 三次 Bézier：更适合模拟圆弧转弯

如果你想让转弯更像真实道路圆弧，可以用三次 Bézier。

先计算等效半径：

[
r'=\frac{\ell}{\tan(\delta/2)}
]

三次 Bézier 的 handle 长度为：

[
h=\frac{4}{3}r'\tan\frac{\delta}{4}
]

然后中心线 Bézier 控制点为：

[
\mathbf{c}_0=\mathbf{a}
]

[
\mathbf{c}_1=\mathbf{a}+h\mathbf{u}
]

[
\mathbf{c}_2=\mathbf{b}-h\mathbf{v}
]

[
\mathbf{c}_3=\mathbf{b}
]

对应曲线：

[
\mathbf{c}(t)
=============

(1-t)^3\mathbf{c}_0
+
3(1-t)^2t\mathbf{c}_1
+
3(1-t)t^2\mathbf{c}_2
+
t^3\mathbf{c}_3
]

这个形式比二次 Bézier 更适合做道路转弯。

---

## 6. 生成道路边界

有两种方法。

### 方法 A：采样中心 Bézier，然后偏移

这是最稳健的方法。

你先把中心线 Bézier 采样为很多点：

[
\mathbf{c}(t_0),\mathbf{c}(t_1),...,\mathbf{c}(t_n)
]

对每个点计算切向量：

[
\mathbf{d}(t)=\mathbf{c}'(t)
]

然后法向量是：

[
\mathbf{n}(t)=
\frac{(-d_y(t), d_x(t))}
{|\mathbf{d}(t)|}
]

于是左右边界为：

[
\mathbf{L}(t)=\mathbf{c}(t)+\frac{w}{2}\mathbf{n}(t)
]

[
\mathbf{R}(t)=\mathbf{c}(t)-\frac{w}{2}\mathbf{n}(t)
]

最后构造闭合 polygon：

[
[
\mathbf{L}_0,
\mathbf{L}_1,
...,
\mathbf{L}_n,
\mathbf{R}*n,
\mathbf{R}*{n-1},
...,
\mathbf{R}_0
]
]

然后 fill。

这是最推荐的方式。

---

### 方法 B：左右边界也用 Bézier

如果你希望边界本身也是 Bézier，而不是采样折线，可以从中心 Bézier 推导左右边界 Bézier。

定义左法向：

[
\mathbf{n}_u=(-u_y,u_x)
]

[
\mathbf{n}_v=(-v_y,v_x)
]

左边界起终点：

[
\mathbf{a}_L=\mathbf{a}+\frac{w}{2}\mathbf{n}_u
]

[
\mathbf{b}_L=\mathbf{b}+\frac{w}{2}\mathbf{n}_v
]

右边界起终点：

[
\mathbf{a}_R=\mathbf{a}-\frac{w}{2}\mathbf{n}_u
]

[
\mathbf{b}_R=\mathbf{b}-\frac{w}{2}\mathbf{n}_v
]

如果转向符号为：

[
\sigma=
\operatorname{sign}
(u_xv_y-u_yv_x)
]

那么：

* (\sigma>0)：左转
* (\sigma<0)：右转

对于 side：

[
s=+1 \quad \text{左边界}
]

[
s=-1 \quad \text{右边界}
]

边界半径为：

[
r_s=r'-s\sigma \frac{w}{2}
]

边界 handle 长度：

[
h_s=
\frac{4}{3}r_s\tan\frac{\delta}{4}
]

边界 Bézier 控制点为：

[
\mathbf{a}_s=\mathbf{a}+s\frac{w}{2}\mathbf{n}_u
]

[
\mathbf{b}_s=\mathbf{b}+s\frac{w}{2}\mathbf{n}_v
]

[
\mathbf{c}_{1,s}=\mathbf{a}_s+h_s\mathbf{u}
]

[
\mathbf{c}_{2,s}=\mathbf{b}_s-h_s\mathbf{v}
]

然后：

[
\mathbf{B}_s(t)
===============

(1-t)^3\mathbf{a}*s
+
3(1-t)^2t\mathbf{c}*{1,s}
+
3(1-t)t^2\mathbf{c}_{2,s}
+
t^3\mathbf{b}_s
]

这就得到左右边界 Bézier。

但是要注意：

[
r_s > 0
]

如果内侧半径：

[
r'-\frac{w}{2} \leq 0
]

说明道路太宽或者转弯半径太小，内侧边界会坍缩或自交。这时应该增大转弯半径，或者改用 polygon union/fill 处理。

---

## 7. 一个转弯面片的闭合路径

对于一个单独转弯，你可以构造如下闭合区域：

```text
left boundary:   a_L  ->  b_L
cross section:   b_L  ->  b_R
right boundary:  b_R  ->  a_R
cross section:   a_R  ->  a_L
fill
```

也就是：

[
[
\mathbf{a}_L,
\text{left Bézier samples},
\mathbf{b}_L,
\mathbf{b}_R,
\text{right Bézier samples reversed},
\mathbf{a}_R
]
]

然后填充。

这就是你说的“转弯全部用填充计算”，这个思路是正确的。

---

## 8. 最小 Python 形式

下面是一个计算单个转弯三次 Bézier 控制点的核心函数：

```python
import numpy as np
import math

def unit(v, eps=1e-9):
    n = np.linalg.norm(v)
    if n < eps:
        raise ValueError("Zero-length vector")
    return v / n

def cubic_bezier(p0, p1, p2, p3, t):
    t = np.asarray(t)
    return (
        (1 - t)[:, None] ** 3 * p0
        + 3 * (1 - t)[:, None] ** 2 * t[:, None] * p1
        + 3 * (1 - t)[:, None] * t[:, None] ** 2 * p2
        + t[:, None] ** 3 * p3
    )

def make_turn_beziers(
    p0,
    p1,
    p2,
    width,
    radius_factor=2.0,
    angle_threshold_deg=5.0,
    clamp_ratio=0.45,
):
    p0 = np.asarray(p0, dtype=float)
    p1 = np.asarray(p1, dtype=float)
    p2 = np.asarray(p2, dtype=float)

    u = unit(p1 - p0)
    v = unit(p2 - p1)

    dot = np.clip(np.dot(u, v), -1.0, 1.0)
    delta = math.acos(dot)

    if delta < math.radians(angle_threshold_deg):
        return None

    len0 = np.linalg.norm(p1 - p0)
    len1 = np.linalg.norm(p2 - p1)

    r_target = radius_factor * width

    ell = min(
        r_target * math.tan(delta / 2),
        clamp_ratio * len0,
        clamp_ratio * len1,
    )

    if ell <= 1e-6:
        return None

    r = ell / math.tan(delta / 2)

    a = p1 - ell * u
    b = p1 + ell * v

    h = (4.0 / 3.0) * r * math.tan(delta / 4)

    center = {
        "p0": a,
        "p1": a + h * u,
        "p2": b - h * v,
        "p3": b,
    }

    sigma = np.sign(u[0] * v[1] - u[1] * v[0])

    n_u = np.array([-u[1], u[0]])
    n_v = np.array([-v[1], v[0]])

    boundaries = {}

    for name, s in [("left", 1.0), ("right", -1.0)]:
        r_side = r - s * sigma * width * 0.5

        if r_side <= 1e-6:
            boundaries[name] = None
            continue

        h_side = (4.0 / 3.0) * r_side * math.tan(delta / 4)

        a_side = a + s * width * 0.5 * n_u
        b_side = b + s * width * 0.5 * n_v

        boundaries[name] = {
            "p0": a_side,
            "p1": a_side + h_side * u,
            "p2": b_side - h_side * v,
            "p3": b_side,
        }

    return {
        "center": center,
        "left": boundaries["left"],
        "right": boundaries["right"],
        "turn_angle_rad": delta,
        "turn_radius": r,
        "turn_length": ell,
        "turn_sign": sigma,
    }
```

如果要得到 polygon，可以采样左右边界：

```python
def sample_turn_polygon(turn, samples=24):
    ts = np.linspace(0.0, 1.0, samples)

    left = turn["left"]
    right = turn["right"]

    if left is None or right is None:
        raise ValueError("Invalid boundary curve; turn radius is too small.")

    left_pts = cubic_bezier(
        left["p0"], left["p1"], left["p2"], left["p3"], ts
    )

    right_pts = cubic_bezier(
        right["p0"], right["p1"], right["p2"], right["p3"], ts
    )

    polygon = np.vstack([
        left_pts,
        right_pts[::-1],
    ])

    return polygon
```

然后这个 `polygon` 就可以直接用于填充。

---

## 9. 交叉口不要当作普通转弯处理

这里有一个很重要的区别：

### 度数为 2 的节点

例如：

```text
A ---- B ---- C
```

其中 B 只是道路中间的一个折点。

这种点可以用 Bézier 转弯处理。

---

### 度数大于等于 3 的节点

例如 T 字路口：

```text
    C
    |
A---B---D
```

或者十字路口：

```text
    C
    |
A---B---D
    |
    E
```

这种节点不要简单用一条 Bézier 曲线处理。因为这里不是“道路转弯”，而是“道路交叉口”。

交叉口更适合做成一个 node patch：

1. 对每条进入交叉口的道路生成左右边界。
2. 在交叉口附近截断每条道路。
3. 收集所有边界端点。
4. 按照极角排序。
5. 生成一个闭合交叉口 polygon。
6. 与道路 strip 做 union 或直接一起 fill。

概念上就是：

[
\text{road surface}
===================

\bigcup_i \text{buffer(edge}_i)
\cup
\text{intersection patch}
]

不要把十字路口看成四个简单转弯，否则很容易出现缝隙、重叠和自交。

---

## 10. 你的方案可以改成这样

你原来的想法：

> 骨架中心线 → 设置转弯阈值 → 设置道路宽度 → 从端点向内找宽度点 → 控制点计算 Bézier → 填充转弯区域

建议改成：

```text
1. 输入道路骨架 polyline / graph
2. 对 degree=2 的折点计算转角
3. 如果转角小于阈值，保持直线
4. 如果转角大于阈值：
   4.1 根据道路宽度 w 设置转弯半径 r = k w
   4.2 根据 r 和转角 δ 计算转弯起点 a 和终点 b
   4.3 用二次或三次 Bézier 平滑中心线
5. 从平滑中心线生成左右 offset boundary
6. 拼接左右边界，形成闭合 polygon
7. fill 得到道路面
8. 对 degree>=3 的节点单独生成 intersection patch
```

核心不是“在边界上随便找控制点”，而是：

```text
中心线先平滑；
边界由中心线 offset 得到；
最终统一 fill。
```

这样可以保证道路宽度稳定，转弯连续，拓扑关系也更容易维护。
