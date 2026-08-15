"use client";

import { useEffect, useMemo, useState } from "react";
import { Overview } from "./components/Overview";
import { RecentActivity } from "./components/RecentActivity";
import { SkillCatalog } from "./components/SkillCatalog";
import { SkillFilters } from "./components/SkillFilters";
import { SyncStatus } from "./components/SyncStatus";
import { TaskMatcher } from "./components/TaskMatcher";
import { fetchCatalog, syncCatalog as requestSync } from "./lib/api";
import { filterSkills, sortSkills, type Catalog, type FilterState, type SortKey } from "./lib/catalog";

const emptyMetrics: Catalog["metrics"] = {
  installed: 0,
  confirmedUsed: 0,
  usedThisMonth: 0,
  needsConfig: 0,
  abnormal: 0,
};

const initialFilters: FilterState = {
  query: "",
  used: "all",
  status: "all",
  category: "all",
  source: "all",
};

export default function Home() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [filters, setFilters] = useState(initialFilters);
  const [sort, setSort] = useState<SortKey>("recent");
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetchCatalog()
      .then((value) => { if (active) setCatalog(value); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "无法读取本机目录"); });
    return () => { active = false; };
  }, []);

  const categories = useMemo(
    () => [...new Set((catalog?.skills ?? []).map((skill) => skill.category))].sort(),
    [catalog],
  );
  const visibleSkills = useMemo(
    () => sortSkills(filterSkills(catalog?.skills ?? [], filters), sort),
    [catalog, filters, sort],
  );

  async function synchronize() {
    setSyncing(true);
    setError("");
    try {
      setCatalog(await requestSync());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "同步失败，已保留上次结果");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow"><span className="pulse" aria-hidden="true" />LOCAL · PRIVATE</div>
          <h1>技能看台</h1>
          <p className="lede">让装过、用过和此刻该用的 Skill 一目了然。</p>
        </div>
        {catalog ? (
          <SyncStatus
            generatedAt={catalog.generatedAt}
            syncing={syncing}
            warningTotal={catalog.warningTotal}
            onSync={synchronize}
          />
        ) : (
          <div className="sync-card loading" role="status">
            <div><span>正在读取本机目录</span><strong>本机私有</strong></div>
          </div>
        )}
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={synchronize}>重试</button>
        </div>
      )}

      <Overview metrics={catalog?.metrics ?? emptyMetrics} />
      <TaskMatcher />

      <section className="catalog panel" aria-labelledby="catalog-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">INVENTORY</p>
            <h2 id="catalog-title">Skill 清单</h2>
          </div>
          <span className="preview-note">
            {catalog ? `${catalog.sessionFileCount} 份历史任务 · ${catalog.sourceCounts.plugin ?? 0} 个插件 Skill` : "载入真实数据中"}
          </span>
        </div>
        <SkillFilters
          filters={filters}
          sort={sort}
          categories={categories}
          count={visibleSkills.length}
          onFilters={setFilters}
          onSort={setSort}
        />
        <SkillCatalog skills={visibleSkills} />
      </section>

      {catalog && <RecentActivity activity={catalog.activity} />}

      <footer>
        <p><strong>提醒说明</strong>：<code>skill-radar</code> 会尽量在相关任务开始时提示最多 3 个 Skill，但隐式匹配不是百分之百保证。</p>
        <p>需要时可显式输入 <code>$skill-radar</code>，或在上方任务匹配器中查询。</p>
      </footer>
    </main>
  );
}
