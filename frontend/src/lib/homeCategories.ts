export type HomeCategorySlug =
  | 'ai-programming'
  | 'ai-cognition'
  | 'skills-tutorial'
  | 'training-plan'
  | 'cognitive-insight'
  | 'trend-analysis'
  | 'finance-analysis'
  | 'product-review'
  | 'learning-notes';

export interface HomeSampleLink {
  title: string;
  desc: string;
  url: string;
}

export interface HomeCategory {
  slug: HomeCategorySlug;
  title: string;
  subtitle: string;
  desc: string;
  image: string;
  /** Lucide icon name — rendered as an SVG icon in the category card. */
  icon: string;
  accent: string;
  samples: HomeSampleLink[];
}

export const HOME_CATEGORIES: HomeCategory[] = [
  {
    slug: 'ai-programming',
    title: 'AI 编程',
    subtitle: '从教程到实战项目',
    desc: '提炼 Cursor、Claude Code、Agent 工作流里的步骤、提示词和避坑经验。',
    image: '/images/categories/ai-programming.webp',
    icon: 'Code2',
    accent: '#2563eb',
    samples: [
      {
        title: '什么是 Vibe Coding？',
        desc: '用通俗语言解释氛围编程的核心原理与操作流程',
        url: 'https://www.iesdouyin.com/share/video/7628696225475214811',
      },
      {
        title: 'AI 编程代码越改越烂？5 招拿捏',
        desc: '破解死亡螺旋，避免 AI 辅助开发越修越乱',
        url: 'https://www.iesdouyin.com/share/video/7645161416617430278',
      },
    ],
  },
  {
    slug: 'ai-cognition',
    title: 'AI 认知',
    subtitle: '理解大模型与 Agent 时代',
    desc: '把 AI 时代、模型能力、人机协作和工作流认知整理成清晰观点。',
    image: '/images/categories/ai-cognition.webp',
    icon: 'Brain',
    accent: '#22d3ee',
    samples: [
      {
        title: '一套 Vibe Coding 工作流吃干抹净 AI',
        desc: '理解“让 AI 做主力，你做总导演”的工作流心法',
        url: 'https://www.iesdouyin.com/share/video/7589968106043362586',
      },
    ],
  },
  {
    slug: 'skills-tutorial',
    title: '技能教程',
    subtitle: '工具教程、软件操作、实用技巧',
    desc: '把软件、剪辑、运营、设计和生活技能视频拆成可复现步骤。',
    image: '/images/categories/skills-tutorial.webp',
    icon: 'BookOpen',
    accent: '#f59e0b',
    samples: [
      {
        title: '单词背诵工具开发实操',
        desc: '从 0 到 1 开发一个可上线的单词背诵网站',
        url: 'https://www.iesdouyin.com/share/video/7644499130202492211',
      },
      {
        title: '用代码还原鱼群形态',
        desc: 'Boids 鱼群算法：把数学公式转成 3D 视觉效果',
        url: 'https://www.iesdouyin.com/share/video/7642345931534322985',
      },
    ],
  },
  {
    slug: 'training-plan',
    title: '训练计划',
    subtitle: '健身、学习、每日任务',
    desc: '把健身、学习路线、备考和挑战类视频拆成按天执行的任务流。',
    image: '/images/categories/training-plan.webp',
    icon: 'Target',
    accent: '#4f5bd5',
    samples: [
      {
        title: '清华大学《Vibe Coding 氛围编程》公开课',
        desc: '系统学习氛围编程思想、工具与训练路径',
        url: 'https://www.iesdouyin.com/share/video/7543581458393337103',
      },
    ],
  },
  {
    slug: 'cognitive-insight',
    title: '认知洞察',
    subtitle: '思维模型、成长观点、人生建议',
    desc: '从成长、商业、表达和判断力内容里提炼核心观点与行动建议。',
    image: '/images/categories/cognitive-insight.webp',
    icon: 'Lightbulb',
    accent: '#60a5fa',
    samples: [
      {
        title: '厌蠢是赚钱的敌人',
        desc: '抖音 · 李守洲谈个人 IP 与自媒体创业的核心心法',
        url: 'https://v.douyin.com/FOBMUnEEE8A/',
      },
      // B站 示例
      {
        title: '独游绕不过的高山：游戏好玩的关键问题',
        desc: 'B站 · 游戏心流设计深度解析，独立游戏开发者必看',
        url: 'https://www.bilibili.com/video/BV112V868E5S/',
      },
      {
        title: '买量被 AI 自动化之后？AppsFlyer MAMA 峰会',
        desc: '公众号 · 游戏出海增长胜负手深度分析',
        url: 'https://mp.weixin.qq.com/s/mjB5IG80UNLI6qXoH0usXQ',
      },
    ],
  },
  {
    slug: 'trend-analysis',
    title: '趋势解读',
    subtitle: '科技、行业、未来机会',
    desc: '把科技变化、行业转向、商业趋势整理成背景、机会和风险。',
    image: '/images/categories/trend-analysis.webp',
    icon: 'TrendingUp',
    accent: '#38bdf8',
    samples: [
      {
        title: '独游绕不过的高山：游戏好玩的关键问题',
        desc: 'B站 · 心流理论与游戏设计深度解析',
        url: 'https://www.bilibili.com/video/BV112V868E5S/',
      },
      {
        title: '买量被 AI 自动化之后？AppsFlyer MAMA 峰会',
        desc: '公众号 · 游戏出海增长胜负手分析',
        url: 'https://mp.weixin.qq.com/s/mjB5IG80UNLI6qXoH0usXQ',
      },
    ],
  },
  {
    slug: 'finance-analysis',
    title: '财经解读',
    subtitle: '经济、投资、市场分析',
    desc: '把宏观经济、市场观点、公司和政策影响整理成信息摘要与风险提示。',
    image: '/images/categories/finance-analysis.webp',
    icon: 'LineChart',
    accent: '#fbbf24',
    samples: [],
  },
  {
    slug: 'product-review',
    title: '产品测评',
    subtitle: 'AI 工具、软件、课程、好物',
    desc: '提炼产品优缺点、适合人群、替代方案和是否值得用。',
    image: '/images/categories/product-review.webp',
    icon: 'Star',
    accent: '#fb7185',
    samples: [
      {
        title: 'AI 创作功能全解析',
        desc: '一键成片、数字人、文案生成等 AI 工具介绍',
        url: 'https://www.iesdouyin.com/share/video/7633402358088682758',
      },
      // B站 示例
      {
        title: '独游绕不过的高山：游戏好玩的关键问题',
        desc: 'B站 · 游戏心流设计深度解析，独立游戏开发者必看',
        url: 'https://www.bilibili.com/video/BV112V868E5S/',
      },
      {
        title: '买量被 AI 自动化之后？AppsFlyer MAMA 峰会',
        desc: '公众号 · 游戏出海增长胜负手深度分析',
        url: 'https://mp.weixin.qq.com/s/mjB5IG80UNLI6qXoH0usXQ',
      },
    ],
  },
  {
    slug: 'learning-notes',
    title: '学习笔记',
    subtitle: '课程、访谈、播客整理',
    desc: '把公开课、讲座、访谈、读书和长视频整理成结构化学习笔记。',
    image: '/images/categories/learning-notes.webp',
    icon: 'FileText',
    accent: '#a78bfa',
    samples: [
      {
        title: '给女朋友做的梦幻 AI 相册',
        desc: '42 轮对话开发个性化 AI 相册，整理成项目学习笔记',
        url: 'https://www.iesdouyin.com/share/video/7642254289469073777',
      },
      {
        title: '一块好玩的水墨屏',
        desc: '用 VibeCoding 快速开发水墨屏应用的创意项目复盘',
        url: 'https://www.iesdouyin.com/share/video/7644946231135472070',
      },
    ],
  },
];
