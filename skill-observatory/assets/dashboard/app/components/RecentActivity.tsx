import { evidenceLabel, formatDate, type ActivityRecord } from "../lib/catalog";

export function RecentActivity({ activity }: { activity: ActivityRecord[] }) {
  return (
    <section className="activity panel" aria-labelledby="activity-title">
      <div className="section-heading compact">
        <div>
          <p className="section-kicker">RECENT ACTIVITY</p>
          <h2 id="activity-title">最近使用</h2>
        </div>
        <span className="preview-note">只显示调用证据，不保存对话正文</span>
      </div>
      {activity.length ? (
        <ol className="activity-list">
          {activity.slice(0, 12).map((item, index) => (
            <li key={`${item.skillId}-${item.invokedAt}-${index}`}>
              <span className="activity-dot" aria-hidden="true" />
              <strong>{item.skillName}</strong>
              <span>{evidenceLabel(item.evidenceType)}</span>
              <time dateTime={item.invokedAt}>{formatDate(item.invokedAt, true)}</time>
            </li>
          ))}
        </ol>
      ) : (
        <div className="empty-state">尚未找到确认使用记录。</div>
      )}
    </section>
  );
}
