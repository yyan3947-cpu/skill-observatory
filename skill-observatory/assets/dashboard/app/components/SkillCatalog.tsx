import { formatDate, SOURCE_LABELS, STATUS_LABELS, type SkillRecord } from "../lib/catalog";

function reasonLabel(reason: string) {
  if (reason.startsWith("missing-env:")) return `缺少配置 ${reason.split(":")[1]}`;
  if (reason.startsWith("missing-executable:")) return `缺少命令 ${reason.split(":")[1]}`;
  if (reason.startsWith("validated-live-read:")) return `外部服务只读实测通过（${reason.split(":")[1]}）`;
  if (reason.startsWith("missing-python-dependency:")) return `缺少 Python 依赖 ${reason.split(":")[1]}`;
  if (reason.startsWith("missing-node-dependency:")) return `缺少 Node.js 依赖 ${reason.split(":")[1]}`;
  return ({
    "external-runtime-not-probed": "外部服务尚未连通验证",
    "structure-valid": "结构检查通过",
    "missing-frontmatter": "缺少有效的 Skill 元数据",
    "missing-name": "缺少 Skill 名称",
    "missing-description": "缺少 Skill 描述",
    "validated-instruction-workflow": "说明、资源与触发流程检查通过",
    "validated-local-toolchain": "本机运行链路检查通过",
    "validated-bundled-runtime": "Codex 内置运行环境检查通过",
    "validated-live-connection:in-app-browser": "应用内浏览器实时连接通过",
    "validated-cli-and-imports": "命令入口与核心依赖导入通过",
    "validated-core-workflow": "核心工作流实测通过",
    "optional-dependencies-missing": "部分可选高级功能仍需额外依赖",
    "validated-single-file-fallback": "单文件降级流程可用",
    "optional-reference-pack-missing": "可选参考资料包未安装",
    "chrome-extension-not-installed": "Chrome 未安装或未启用 ChatGPT/Codex 浏览器扩展",
    "no-active-excel-session": "当前没有可连接的 Excel 加载项会话",
    "plugin-tool-not-registered-restart-or-reconnect": "插件工具未注册，请重启 Codex 或重新连接插件",
    "no-valid-microsoft-teams-license": "Microsoft Teams 连接返回无有效许可证",
    "mediacrawler-runtime-not-installed": "MediaCrawler 主程序尚未安装到本机",
    "incomplete-install:referenced-resources-missing": "安装不完整：Skill 引用的资源文件缺失",
  } as Record<string, string>)[reason] ?? reason;
}

function methodLabel(method: string) {
  return ({
    "live-read": "外部服务只读实测",
    "live-browser-connection": "浏览器连接实测",
    "connector-diagnostics": "连接器诊断",
    "local-toolchain": "本机运行链路",
    "dependency-audit": "依赖与入口检查",
    "structure-and-instruction": "结构与说明检查",
  } as Record<string, string>)[method] ?? method;
}

export function SkillCatalog({ skills }: { skills: SkillRecord[] }) {
  if (!skills.length) return <div className="empty-state">当前筛选条件下没有 Skill。</div>;
  return (
    <div className="skill-list">
      {skills.map((skill, index) => (
        <details className="skill-row" key={skill.id}>
          <summary>
            <span className="skill-index">{String(index + 1).padStart(2, "0")}</span>
            <div className="skill-copy">
              <div className="skill-titleline">
                <h3>{skill.name}</h3>
                <span>{skill.category}</span>
              </div>
              <p>{skill.summaryZh}</p>
              <div className="skill-meta">
                <span>{SOURCE_LABELS[skill.sourceType]} · {skill.sourceLabel}</span>
                <span>{skill.usageCount ?? "—"} 次</span>
                <span>{formatDate(skill.lastUsedAt)}</span>
                {skill.summaryState === "source-fallback" && <span>待整理</span>}
              </div>
            </div>
            <span className={`status ${skill.status}`}>{STATUS_LABELS[skill.status]}</span>
            <span className="expand-mark" aria-hidden="true">＋</span>
          </summary>
          <div className="skill-detail">
            <div>
              <h4>原始描述</h4>
              <p>{skill.description || "未提供描述"}</p>
            </div>
            <dl>
              <div><dt>安装路径</dt><dd>{skill.path}</dd></div>
              <div><dt>状态依据</dt><dd>{skill.statusReasons.map(reasonLabel).join("；") || "无"}</dd></div>
              {skill.validatedAt && (
                <div><dt>最近验证</dt><dd>{formatDate(skill.validatedAt, true)} · {methodLabel(skill.validationMethod ?? "manual")}</dd></div>
              )}
              <div><dt>所需配置</dt><dd>{skill.requiredEnvNames.join("、") || "未检测到"}</dd></div>
              <div><dt>触发别名</dt><dd>{skill.aliases.join("、") || "未设置"}</dd></div>
              <div><dt>警告</dt><dd>{skill.warnings.join("、") || "无"}</dd></div>
            </dl>
          </div>
        </details>
      ))}
    </div>
  );
}
