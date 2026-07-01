# 首页分类卡片背景图 · 生成提示词

本目录存放首页 9 个分类卡片的背景图。文件名与 `frontend/src/lib/homeCategories.ts` 中各分类的 `image` 字段一一对应,**文件名和路径不能改**,否则前端加载不到:

```
frontend/public/images/categories/
  ai-programming.webp      AI 编程       accent #10b981
  ai-cognition.webp        AI 认知       accent #22d3ee
  skills-tutorial.webp     技能教程      accent #f59e0b
  training-plan.webp       训练计划      accent #6366f1
  cognitive-insight.webp   认知洞察      accent #34d399
  trend-analysis.webp      趋势解读      accent #38bdf8
  finance-analysis.webp    财经解读      accent #fbbf24
  product-review.webp      产品测评      accent #fb7185
  learning-notes.webp      学习笔记      accent #a78bfa
```

## 输出规格

- **格式**:WebP
- **尺寸**:1600 × 1000 px(约 16:10),卡片会在不同屏幕裁切居中显示
- **风格统一**:暗色玻璃拟态,基底接近 `#0a0a0f`,极简抽象,**画面中不要出现任何文字、字母、数字、水印、UI 控件**
- **构图**:主体偏左上,右下大面积留暗(卡片文字叠在底部),便于标题/描述可读
- **配色**:每张图以其 `accent` 色为主光晕,辅以深绿/深蓝暗调,避免高饱和大面积平涂
- **质感**:柔和体积光、轻微噪点、微弱辉光,不要照片级写实,偏 3D/矢量抽象

> 通用后缀(每条提示词末尾都加上):
> `dark glassmorphism background, base color near #0a0a0f, soft volumetric glow in <ACCENT>, abstract minimal, no text, no letters, no numbers, no UI elements, no watermark, subject in upper-left, large dark negative space in lower-right, subtle grain, 16:10, webp`

## 各分类提示词

### 1. ai-programming.webp · AI 编程 · #10b981
```
A glowing code editor window floating in dark space, abstract cursor beam and streaming code lines dissolving into particles, an AI agent node graph woven through the lines, emerald green volumetric light, <通用后缀, ACCENT=emerald #10b981>
```

### 2. ai-cognition.webp · AI 认知 · #22d3ee
```
A semi-transparent human head profile in outline, neural network nodes and synapses glowing inside, a small human figure and a robot figure reaching toward each other, cyan light, <通用后缀, ACCENT=cyan #22d3ee>
```

### 3. skills-tutorial.webp · 技能教程 · #f59e0b
```
Abstract floating software tool panels and a cursor, layered step-by-step progress markers like glowing dots connected in sequence, amber light, <通用后缀, ACCENT=amber #f59e0b>
```

### 4. training-plan.webp · 训练计划 · #6366f1
```
A minimal calendar grid fading into a progress path climbing upward, abstract dumbbell and checkpoint flags along the path, indigo light, <通用后缀, ACCENT=indigo #6366f1>
```

### 5. cognitive-insight.webp · 认知洞察 · #34d399
```
A glowing lightbulb above a mountain peak made of stacked abstract idea blocks, radiating concentric thought rings, green light, <通用后缀, ACCENT=green #34d399>
```

### 6. trend-analysis.webp · 趋势解读 · #38bdf8
```
An upward rising arrow formed from glowing data points, a radar sweep arc and abstract horizon line below, sky blue light, <通用后缀, ACCENT=sky blue #38bdf8>
```

### 7. finance-analysis.webp · 财经解读 · #fbbf24
```
Abstract candlestick chart and a rising line graph floating, minimal coin rings and a subtle grid backdrop, golden light, <通用后缀, ACCENT=gold #fbbf24>
```

### 8. product-review.webp · 产品测评 · #fb7185
```
An abstract product box floating with a five-star rating formed from glowing dots, comparison split-plane silhouette behind it, rose light, <通用后缀, ACCENT=rose #fb7185>
```

### 9. learning-notes.webp · 学习笔记 · #a78bfa
```
An open notebook with pages turning into a growing knowledge tree, glowing branch nodes, violet light, <通用后缀, ACCENT=violet #a78bfa>
```

## 使用方式

1. 用任意图模型(Midjourney / Nano Banana / 即梦 / GPT 画图等)按上述提示词生成,或自行调整。
2. 导出为 WebP,按对应文件名放入本目录。
3. 无需改代码 —— `homeCategories.ts` 已指向这些路径,前端会自动加载。
4. 生成前卡片会以 accent 色渐变作为优雅 fallback;替换后立即显示。

## 命名对照速查

| 文件名 | 分类 | accent |
|--------|------|--------|
| ai-programming.webp | AI 编程 | #10b981 |
| ai-cognition.webp | AI 认知 | #22d3ee |
| skills-tutorial.webp | 技能教程 | #f59e0b |
| training-plan.webp | 训练计划 | #6366f1 |
| cognitive-insight.webp | 认知洞察 | #34d399 |
| trend-analysis.webp | 趋势解读 | #38bdf8 |
| finance-analysis.webp | 财经解读 | #fbbf24 |
| product-review.webp | 产品测评 | #fb7185 |
| learning-notes.webp | 学习笔记 | #a78bfa |
