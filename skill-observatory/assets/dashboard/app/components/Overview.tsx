import type { Catalog } from "../lib/catalog";

export function Overview({ metrics }: { metrics: Catalog["metrics"] }) {
  const items = [
    ["已安装", metrics.installed],
    ["历史用过", metrics.confirmedUsed],
    ["本月使用", metrics.usedThisMonth],
    ["需配置", metrics.needsConfig],
    ["异常", metrics.abnormal],
  ];
  return (
    <section className="metrics" aria-label="Skill 总览">
      {items.map(([label, value]) => (
        <article className="metric" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </article>
      ))}
    </section>
  );
}
