import type {
  AnalyticsConfig,
  CommentConfig,
  GithubConfig,
  Link,
  PhotosConfig,
  PostConfig,
  ProjectConfig,
  Site,
  SkillsShowcaseConfig,
  SocialLink,
  TagsConfig,
} from '~/types'

//--- Readme Page Config ---
export const SITE: Site = {
  title: 'JunBlog',
  description: '个人博客，记录阅读、技术与日常。',
  website: 'https://junaoe.dev',
  lang: 'zh',
  base: '/',
  author: 'junaoe',
  ogImage: '/og-image.webp',
  transition: false,
  themeAnimation: true,
}

export const HEADER_LINKS: Link[] = [
  {
    name: '文章',
    url: '/posts',
  },
  {
    name: '项目',
    url: '/projects',
  },
  {
    name: '相册',
    url: '/photos',
  },
]

export const FOOTER_LINKS: Link[] = [
  {
    name: '首页',
    url: '/',
  },
  {
    name: '文章',
    url: '/posts',
  },
  {
    name: '项目',
    url: '/projects',
  },
  {
    name: '标签',
    url: '/tags',
  },
  {
    name: '相册',
    url: '/photos',
  },
]

// get icon https://icon-sets.iconify.design/
// 填上你的账号地址即可显示；留空字符串则自动隐藏
export const SOCIAL_LINKS: SocialLink[] = [
  {
    name: 'github',
    url: 'https://github.com/junaoee',
    icon: 'icon-[ri--github-fill]',
  },
  {
    name: 'twitter',
    url: 'https://x.com/junaoe',
    icon: 'icon-[ri--twitter-x-fill]',
  },
  {
    // 暂时不显示，之后填上地址就会自动出现
    name: 'bilibili',
    url: '',
    icon: 'icon-[ri--bilibili-fill]',
  },
  {
    name: 'mail',
    url: '',
    icon: 'icon-[ri--mail-fill]',
  },
]

/**
 * SkillsShowcase 配置接口 / SkillsShowcase configuration type
 * @property {boolean} SKILLS_ENABLED  - 是否启用SkillsShowcase功能 / Whether to enable SkillsShowcase features
 * @property {Object} SKILLS_DATA - 技能展示数据 / Skills showcase data
 * @property {string} SKILLS_DATA.direction - 技能展示方向 / Skills showcase direction
 * @property {Object} SKILLS_DATA.skills - 技能展示数据 / Skills showcase data
 * @property {string} SKILLS_DATA.skills.icon - 技能图标 / Skills icon
 * @property {string} SKILLS_DATA.skills.name - 技能名称 / Skills name
 * get icon https://icon-sets.iconify.design/
 */
export const SKILLSSHOWCASE_CONFIG: SkillsShowcaseConfig = {
  SKILLS_ENABLED: true,
  SKILLS_DATA: [
    {
      direction: 'left',
      skills: [
        {
          name: 'ChatGPT',
          icon: 'icon-[logos--openai-icon]',
          url: 'https://chatgpt.com/',
        },
        {
          name: 'DeepSeek',
          icon: 'icon-[logos--deepseek-icon]',
          url: 'https://chat.deepseek.com/',
        },
        {
          name: '豆包',
          icon: 'icon-[simple-icons--bytedance]',
          url: 'https://www.doubao.com/',
        },
      ],
    },
    {
      direction: 'right',
      skills: [
        {
          name: 'Ollama',
          icon: 'icon-[simple-icons--ollama]',
          url: 'https://ollama.com/',
        },
        {
          name: 'Cursor',
          icon: 'icon-[simple-icons--cursor]',
          url: 'https://cursor.com/',
        },
      ],
    },
  ],
}

/**
 * GitHub配置 / GitHub configuration
 *
 * @property {boolean} ENABLED - 是否启用GitHub功能 / Whether to enable GitHub features
 * @property {string} GITHUB_USERNAME - GITHUB用户名 / GitHub username
 * @property {boolean} TOOLTIP_ENABLED - 是否开启Tooltip功能 / Whether to enable Github Tooltip features
 */

export const GITHUB_CONFIG: GithubConfig = {
  ENABLED: true,
  GITHUB_USERNAME: 'junaoee',
  TOOLTIP_ENABLED: true,
}

//--- Posts Page Config ---
export const POSTS_CONFIG: PostConfig = {
  title: '文章',
  description: '全部文章',
  introduce: '这里记录我的阅读、技术与日常。',
  author: 'junaoe',
  homePageConfig: {
    size: 2,
    type: 'compact',
  },
  postPageConfig: {
    size: 10,
    type: 'image',
    coverLayout: 'right',
  },
  tagsPageConfig: {
    size: 10,
    type: 'time-line',
  },
  ogImageUseCover: false,
  postType: 'metaOnly',
  imageDarkenInDark: true,
  readMoreText: '阅读全文',
  prevPageText: '上一页',
  nextPageText: '下一页',
  tocText: '目录',
  backToPostsText: '返回文章列表',
  nextPostText: '下一篇',
  prevPostText: '上一篇',
  recommendText: '推荐',
  wordCountView: true,
}

export const COMMENT_CONFIG: CommentConfig = {
  enabled: true,
  system: 'giscus',
  // giscus 配置：repo / category 字段需要 giscus.app 生成，
  // repoId 与 categoryId 是 GitHub 内部 ID，会随仓库/分类变化，升级时需重新取
  giscus: {
    repo: 'junaoee/blog',
    repoId: 'R_kgDOVKf33w',
    category: 'Announcements',
    categoryId: 'DIC_kwDOVKf3384DIfHp',
    mapping: 'pathname', // 用页面路径做唯一标识，一篇文章对应一个讨论
    strict: '1', // 严格模式：路径必须完全一致，防止不同文章的评论串台
    reactionsEnabled: '1', // 开启表情回应
    emitMetadata: '0', // 访客嵌入 iframe 时代替页面元信息
    inputPosition: 'bottom', // 输入框放在评论列表下方
    lang: 'zh-CN',
    loading: 'lazy',
  },
  gitalk: {
    clientID: import.meta.env.PUBLIC_GITHUB_CLIENT_ID,
    clientSecret: import.meta.env.PUBLIC_GITHUB_CLIENT_SECRET,
    repo: 'gitalk-comment',
    owner: '',
    admin: [],
    language: 'zh-CN',
    perPage: 5,
    pagerDirection: 'last',
    createIssueManually: false,
    distractionFreeMode: false,
    enableHotKey: true,
  },
}

export const TAGS_CONFIG: TagsConfig = {
  title: '标签',
  description: '全部标签',
  introduce: '所有文章的标签都在这里，点击可以筛选。',
}

export const PROJECTS_CONFIG: ProjectConfig = {
  title: '项目',
  description: '我做过的一些东西。',
  introduce: '这里放我的个人项目。',
}

export const PHOTOS_CONFIG: PhotosConfig = {
  title: '相册',
  description: '记录日常的照片。',
  introduce: '平时拍的一些照片。',
}

export const ANALYTICS_CONFIG: AnalyticsConfig = {
  vercount: {
    enabled: false,
  },
  umami: {
    enabled: false,
    websiteId: 'Your websiteId in umami',
    serverUrl: 'https://cloud.umami.is/script.js',
  },
}
