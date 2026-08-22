import type {
  FaqEntry,
  FeatureRow,
  FooterColumn,
  MegaPanel,
  NavItem,
  ResourceCard,
  WhyBlock,
} from "@/types/dynadot";

export const ASSETS = "/sites/www-dynadot-com-7f8c2392/root-8a5edab2";

export const ANNOUNCEMENT =
  "六类域名工具免费开放：可注册查询 · WHOIS / RDAP · DNS / NS · SSL / CAA · IDN / Punycode · TLD 价格";

/**
 * Header account entry. The app has no dedicated /auth page yet (only the WeChat
 * confirmation callback), so the account surface itself is the entry for now.
 */
export const ACCOUNT_LINK: NavItem = { label: "登录", href: "/account/domains" };

export const PRIMARY_NAV: NavItem[] = [
  { label: "工具", href: "/tools" },
  { label: "价格", href: "/pricing" },
  { label: "内容", href: "/articles" },
  { label: "帮助", href: "/help" },
];

/**
 * Hover mega-menu panels. Panel geometry is unchanged from the source
 * (`top: 111`, `#031242`, `padding: 45px 0 0`); columns are 345px for
 * two-column panels and 290px for three-column ones.
 */
export const MEGA_PANELS: MegaPanel[] = [
  {
    label: "工具",
    title: "域名工具",
    lead: "六类查询工具，打开即用",
    leadHref: "/tools",
    columnWidth: 290,
    columns: [
      {
        heading: "查询",
        links: [
          { label: "域名可注册查询", href: "/tools/domain-search" },
          { label: "WHOIS / RDAP", href: "/tools/whois" },
          { label: "DNS / NS 查询", href: "/tools/dns" },
        ],
      },
      {
        heading: "检查与转换",
        links: [
          { label: "SSL / CAA 检查", href: "/tools/ssl-check" },
          { label: "IDN / Punycode", href: "/tools/idn" },
        ],
      },
      {
        heading: "价格",
        links: [
          { label: "TLD 价格与成本", href: "/pricing" },
          { label: "工具中心与本地工具箱", href: "/tools" },
        ],
      },
    ],
  },
  {
    label: "价格",
    title: "价格与后缀",
    lead: "先比价，再决定",
    leadHref: "/pricing",
    columnWidth: 345,
    columns: [
      {
        heading: "价格",
        links: [
          { label: "TLD 价格与成本", href: "/pricing" },
          { label: "TLD 页面", href: "/tld" },
        ],
      },
      {
        heading: "规则",
        links: [
          { label: "支付说明", href: "/legal/payment" },
          { label: "实名说明", href: "/legal/realname" },
        ],
      },
    ],
  },
  {
    label: "内容",
    title: "内容",
    lead: "教程、评测与真实实践",
    leadHref: "/articles",
    columnWidth: 345,
    columns: [
      {
        heading: "阅读",
        links: [
          { label: "实用内容", href: "/articles" },
          { label: "专题与指南", href: "/topics" },
        ],
      },
      {
        heading: "后缀",
        links: [{ label: "TLD 页面", href: "/tld" }],
      },
    ],
  },
  {
    label: "帮助",
    title: "帮助",
    lead: "数据来源与使用说明",
    leadHref: "/help",
    columnWidth: 290,
    columns: [
      {
        heading: "帮助",
        links: [
          { label: "帮助中心", href: "/help" },
          { label: "联系我们", href: "/contact" },
        ],
      },
      {
        heading: "反馈",
        links: [
          { label: "提交反馈", href: "/feedback" },
          { label: "提交需求", href: "/requests" },
        ],
      },
      {
        heading: "法律",
        links: [
          { label: "使用条款", href: "/legal/terms" },
          { label: "隐私说明", href: "/legal/privacy" },
        ],
      },
    ],
  },
];

/**
 * Hero search. Only the availability lookup exists here (no transfer, AI or
 * bulk search), so the tab row carries a single tab. The form submits a GET to
 * the same route, with the same parameter name, label, placeholder and privacy
 * note as the tool page's own query form; normalisation happens server-side.
 */
export const SEARCH_TABS = ["可注册查询"] as const;

export const SEARCH_FORM = {
  action: "/tools/domain-search",
  buttonLabel: "查询域名",
  description:
    "支持完整域名与关键词。启用浏览器历史时，提交内容只保存在当前浏览器。",
  label: "输入完整域名或关键词",
  placeholder: "例如 wanmi.net 或品牌关键词",
  tool: "domain-search",
} as const;

export const HERO = {
  eyebrow: "域名搜索、比价与工具平台",
  titleLead: "一个搜索框，看清",
  titleHighlight: "域名状态与价格",
  titleTail: "。",
} as const;

/** Section-level CTA pills, each pointing at a real route. */
export const SECTION_CTAS = {
  features: { label: "浏览全部工具", href: "/tools" },
  why: { label: "查看数据来源与使用说明", href: "/help" },
  resources: { label: "查看全部内容", href: "/articles" },
  contact: { label: "联系我们", href: "/contact" },
} as const;

export const FEATURE_ROWS: FeatureRow[] = [
  {
    title: "查域名是否可注册",
    body: "输入完整域名或关键词，查看可注册状态与多后缀结果。查询失败、超时或未知状态不会被当成可注册。",
    cta: "开始查询",
    href: "/tools/domain-search",
    image: `${ASSETS}/images/domain-entry-buy.webp`,
    alt: "域名查询插画",
    imageRight: true,
  },
  {
    title: "比较 TLD 价格与成本",
    body: "按后缀查看注册、续费、最低年限与 1 年 / 3 年成本。价格以服务端确认的有效报价为准，未配置的后缀不开放购买。",
    cta: "查看价格",
    href: "/pricing",
    image: `${ASSETS}/images/domain-entry-transfer.webp`,
    alt: "价格比较插画",
    imageRight: false,
  },
];

export const WHY_BLOCKS: WhyBlock[] = [
  {
    title: "可售与价格",
    body: "域名可售状态、价格和注册规则由西部数码提供。只有服务端确认且配置了有效价格时，才会开放交易入口。",
    cta: "了解价格来源",
    href: "/help",
    image: `${ASSETS}/images/why-dynadot-pointer-icon.webp`,
    alt: "指针插画",
  },
  {
    title: "公开注册信息",
    body: "WHOIS / RDAP 通过 Who-Dat 和注册局公开数据提供，并与可注册状态严格分离。隐私保护或注册局策略可能导致字段缺失。",
    cta: "查询 WHOIS",
    href: "/tools/whois",
    image: `${ASSETS}/images/why-dynadot-people-icon.webp`,
    alt: "人物插画",
  },
  {
    title: "DNS 与证书",
    body: "DNS、Name Server、TLS 证书与 CAA 来自公开网络查询。结果附查询时间，不承诺全球解析器即时一致。",
    cta: "检查 DNS 与 SSL",
    href: "/tools/dns",
    image: `${ASSETS}/images/why-dynadot-pie-icon.webp`,
    alt: "图表插画",
  },
  {
    title: "失败与未知状态",
    body: "查询失败、数据源超时和未知状态不会被解释为未注册或可购买。错误页面会给出建议动作和请求 ID。",
    cta: "查看使用说明",
    href: "/help",
    image: `${ASSETS}/images/why-dynadot-security-icon.webp`,
    alt: "安全插画",
  },
];

export const RESOURCE_CARDS: ResourceCard[] = [
  {
    title: "实用内容",
    body: "域名、网站与工具的教程、评测和实践记录，只写做产品的人用得上的内容。",
    cta: "阅读实用内容",
    href: "/articles",
  },
  {
    title: "专题与指南",
    body: "按主题整理的指南与对比，把一个问题从查询讲到下一步。",
    cta: "浏览专题",
    href: "/topics",
  },
  {
    title: "帮助中心",
    body: "数据来源、查询时间、缓存状态与失败原因的说明，以及当前的服务边界。",
    cta: "进入帮助中心",
    href: "/help",
  },
];

/**
 * Answers describe what the site does today: the public tools are live, while
 * registration, payment and fulfilment stay closed until launch approval.
 */
export const FAQS: FaqEntry[] = [
  {
    question: "查询结果显示“可注册”，就一定能注册吗？",
    answer: [
      "“可注册”来自西部数码的服务端确认，并附查询时间；查询失败、超时或未知状态不会显示为可注册。",
      "注册、支付和履约能力尚未开放，当前页面不接受真实交易。",
    ],
  },
  {
    question: "WHOIS / RDAP 信息为什么有些字段是空的？",
    answer: [
      "公开注册信息通过 Who-Dat 和注册局公开数据提供。注册局策略、隐私保护或数据源失败都可能导致字段缺失，缺失不代表域名未注册。",
    ],
  },
  {
    question: "价格从哪里来，会不会和最终价不一样？",
    answer: [
      "价格中心按后缀列出注册、续费、最低年限和 1 年 / 3 年成本，来源是西部数码的价格数据与本站的加价规则。",
      "最终以服务端确认的有效报价为准，未配置加价的后缀不开放购买。",
    ],
  },
  {
    question: "DNS、SSL 的结果为什么和我本地看到的不一样？",
    answer: [
      "DNS、Name Server、TLS 证书和 CAA 来自公开网络查询，结果会标注查询时间。不同递归解析器存在传播延迟，页面不承诺全球即时一致。",
    ],
  },
  {
    question: "中文域名怎么查？",
    answer: [
      "用 IDN / Punycode 工具在 Unicode 中文域名与 ASCII Punycode 之间转换，查询结果会同时显示 Punycode 形式。",
    ],
  },
  {
    question: "我的查询会被保存吗？",
    answer: [
      "查询结果页不会被搜索引擎收录，服务端也不会长期保存完整的查询域名。",
      "启用浏览器本地历史时，提交内容只保存在当前浏览器；开启 DNT / GPC 隐私信号后不会自动记录。",
    ],
  },
  {
    question: "失败或超时的查询怎么处理？",
    answer: [
      "失败页面会说明原因、给出建议动作并提供请求 ID，方便反馈。失败与未知状态不会被解释为可注册。",
    ],
  },
  {
    question: "现在可以注册域名或付款吗？",
    answer: [
      "还不可以。当前是开发中的公共站，不接受真实注册、续费、支付或实名材料；生产开放前仍需完成接口联调、资质备案、合规复核和最终批准。",
    ],
  },
];

export const FOOTER_TAGLINE = {
  title: "面向中文用户的域名工具与服务入口",
  body: "数据来源与查询时间标注在每个结果旁边，不用模糊结论代替不确定性。",
  bottom: "少一点概念，多一点能用的工具。",
} as const;

export const FOOTER_COLUMNS: FooterColumn[] = [
  {
    heading: "工具",
    links: [
      { label: "域名可注册查询", href: "/tools/domain-search" },
      { label: "WHOIS / RDAP", href: "/tools/whois" },
      { label: "DNS / NS 查询", href: "/tools/dns" },
      { label: "SSL / CAA 检查", href: "/tools/ssl-check" },
      { label: "IDN / Punycode", href: "/tools/idn" },
      { label: "工具中心", href: "/tools" },
    ],
  },
  {
    heading: "价格与内容",
    links: [
      { label: "TLD 价格与成本", href: "/pricing" },
      { label: "TLD 页面", href: "/tld" },
      { label: "实用内容", href: "/articles" },
      { label: "专题与指南", href: "/topics" },
    ],
  },
  {
    heading: "帮助",
    links: [
      { label: "帮助中心", href: "/help" },
      { label: "联系我们", href: "/contact" },
      { label: "提交反馈", href: "/feedback" },
      { label: "提交需求", href: "/requests" },
    ],
  },
  {
    heading: "账号",
    links: [
      { label: "登录", href: "/account/domains" },
      { label: "我的域名", href: "/account/domains" },
    ],
  },
];

export const FOOTER_LEGAL: NavItem[] = [
  { label: "隐私说明", href: "/legal/privacy" },
  { label: "使用条款", href: "/legal/terms" },
  { label: "实名说明", href: "/legal/realname" },
  { label: "支付说明", href: "/legal/payment" },
  { label: "Cookie 说明", href: "/legal/cookies" },
  { label: "广告说明", href: "/legal/advertising" },
];
