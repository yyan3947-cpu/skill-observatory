export const CATALOG_SCHEMA_VERSION = 1;

export const SOURCE_TYPES = Object.freeze({
  USER: "user",
  REPO: "repo",
  SYSTEM: "system",
  PLUGIN: "plugin",
});

export const SKILL_STATUSES = Object.freeze({
  READY: "ready",
  NEEDS_CONFIG: "needs-config",
  ABNORMAL: "abnormal",
  UNCHECKED: "unchecked",
});

export const APPROVED_CATEGORIES = Object.freeze([
  "小红书与社交内容",
  "演示与视觉设计",
  "UI/UX 与网站",
  "写作与文档",
  "投资与市场",
  "开发流程与代码",
  "数据与办公",
  "连接器与自动化",
  "思维框架",
  "系统与管理",
  "其他",
]);

export const MAX_WARNING_EXAMPLES = 50;
export const DEFAULT_API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 4318;
export const MAX_QUERY_BYTES = 4096;
export const MAX_REQUEST_BODY_BYTES = 8192;
