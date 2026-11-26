"use client";
/** UI dictionary (EN / 简体中文). Navigation, shell and common actions are fully translated; page bodies translate headings via t(). */
export type Lang = "en" | "zh";
const D: Record<string, { en: string; zh: string }> = {
  copilot: { en: "AI Copilot", zh: "AI 助手" }, overview: { en: "Overview", zh: "总览" }, opportunities: { en: "Opportunity Finder", zh: "机会发现" },
  audience: { en: "Audience", zh: "受众" }, offers: { en: "Personalized Offers", zh: "个性化权益" }, campaigns: { en: "Campaign", zh: "营销活动" },
  journeys: { en: "Journey Builder", zh: "旅程编排" }, channels: { en: "Omni Channel", zh: "全渠道" }, analytics: { en: "Analytics", zh: "分析" },
  optimizer: { en: "AI Strategy Optimizer", zh: "AI 策略优化" }, compliance: { en: "Compliance", zh: "合规" }, settings: { en: "Settings", zh: "设置" },
  search: { en: "Search or run a command…", zh: "搜索或执行命令…" }, last: { en: "Last", zh: "最近" }, days: { en: "days", zh: "天" },
  notifications: { en: "Notifications", zh: "通知" }, mark_read: { en: "Mark all read", zh: "全部已读" }, sign_out: { en: "Sign out", zh: "退出登录" },
  theme: { en: "Theme", zh: "主题" }, language: { en: "Language", zh: "语言" }, ask_copilot: { en: "Ask Copilot", zh: "询问助手" },
  emergency_stop: { en: "Emergency stop", zh: "紧急停止" }, emergency_active: { en: "EMERGENCY STOP ACTIVE", zh: "紧急停止已启用" },
  mock_mode: { en: "Mock mode · synthetic data", zh: "模拟模式 · 合成数据" }, export: { en: "Export CSV", zh: "导出 CSV" }, refresh: { en: "Refresh", zh: "刷新" },
  run_now: { en: "Run now", zh: "立即运行" }, simulate: { en: "Simulate", zh: "模拟" }, approve: { en: "Approve", zh: "批准" }, reject: { en: "Reject", zh: "拒绝" },
  request_changes: { en: "Request changes", zh: "要求修改" }, save: { en: "Save", zh: "保存" }, cancel: { en: "Cancel", zh: "取消" }, create: { en: "Create", zh: "创建" },
  loading: { en: "Loading…", zh: "加载中…" }, empty: { en: "Nothing here yet", zh: "暂无数据" }, error: { en: "Something went wrong", zh: "出错了" }, retry: { en: "Retry", zh: "重试" },
  customer_metrics: { en: "Customers", zh: "客户" }, gaming_metrics: { en: "Gaming", zh: "游戏" }, engagement_metrics: { en: "Engagement", zh: "触达" }, ai_metrics: { en: "AI operations", zh: "AI 运营" }, offer_metrics: { en: "Offers", zh: "权益" },
  insights: { en: "AI insights", zh: "AI 洞察" }, approvals: { en: "Approvals", zh: "审批" }, audit: { en: "Audit", zh: "审计" }, policies: { en: "Policies", zh: "策略" },
  segments: { en: "Segments", zh: "分群" }, customer360: { en: "Customer 360°", zh: "客户 360°" }, templates: { en: "Templates", zh: "模板" }, delivery: { en: "Delivery", zh: "投递" },
  all_platforms: { en: "All platforms", zh: "全部平台" }, all_providers: { en: "All providers", zh: "全部厂商" }, all_channels: { en: "All channels", zh: "全部渠道" }, all_segments: { en: "All segments", zh: "全部分群" },
  new_chat: { en: "New conversation", zh: "新对话" }, send: { en: "Send", zh: "发送" }, stop: { en: "Stop", zh: "停止" }, regenerate: { en: "Regenerate", zh: "重新生成" },
};
export function translate(lang: Lang, key: string) { return D[key]?.[lang] ?? D[key]?.en ?? key; }
