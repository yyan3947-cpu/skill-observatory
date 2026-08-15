import type { FilterState, SortKey } from "../lib/catalog";

export function SkillFilters({
  filters,
  sort,
  categories,
  count,
  onFilters,
  onSort,
}: {
  filters: FilterState;
  sort: SortKey;
  categories: string[];
  count: number;
  onFilters: (filters: FilterState) => void;
  onSort: (sort: SortKey) => void;
}) {
  function patch<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    onFilters({ ...filters, [key]: value });
  }
  return (
    <div className="filter-wrap">
      <div className="search-field">
        <label htmlFor="skill-search">搜索 Skill</label>
        <input
          id="skill-search"
          type="search"
          value={filters.query}
          placeholder="名称、用途或触发词"
          onChange={(event) => patch("query", event.target.value)}
        />
      </div>
      <div className="select-grid">
        <label>
          使用记录
          <select value={filters.used} onChange={(event) => patch("used", event.target.value as FilterState["used"])}>
            <option value="all">全部</option>
            <option value="used">用过</option>
            <option value="unused">未用</option>
          </select>
        </label>
        <label>
          状态
          <select value={filters.status} onChange={(event) => patch("status", event.target.value as FilterState["status"])}>
            <option value="all">全部</option>
            <option value="ready">可用</option>
            <option value="needs-config">需配置</option>
            <option value="abnormal">异常</option>
            <option value="unchecked">待检查</option>
          </select>
        </label>
        <label>
          分类
          <select value={filters.category} onChange={(event) => patch("category", event.target.value)}>
            <option value="all">全部</option>
            {categories.map((category) => <option key={category}>{category}</option>)}
          </select>
        </label>
        <label>
          来源
          <select value={filters.source} onChange={(event) => patch("source", event.target.value as FilterState["source"])}>
            <option value="all">全部</option>
            <option value="user">个人</option>
            <option value="repo">项目</option>
            <option value="system">系统</option>
            <option value="plugin">插件</option>
          </select>
        </label>
        <label>
          排序
          <select value={sort} onChange={(event) => onSort(event.target.value as SortKey)}>
            <option value="recent">最近使用</option>
            <option value="usage">使用次数</option>
            <option value="name">名称</option>
            <option value="category">分类</option>
            <option value="status">状态</option>
          </select>
        </label>
      </div>
      <p className="result-count" aria-live="polite">当前显示 {count} 个 Skill</p>
    </div>
  );
}
