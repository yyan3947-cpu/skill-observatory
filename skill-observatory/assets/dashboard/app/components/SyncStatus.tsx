import { formatDate } from "../lib/catalog";

export function SyncStatus({
  generatedAt,
  syncing,
  warningTotal,
  onSync,
}: {
  generatedAt: string;
  syncing: boolean;
  warningTotal: number;
  onSync: () => void;
}) {
  return (
    <div className="sync-card" aria-live="polite">
      <div>
        <span>{syncing ? "正在重新同步" : `更新于 ${formatDate(generatedAt, true)}`}</span>
        <strong>本机私有</strong>
      </div>
      <button type="button" className="secondary-button" onClick={onSync} disabled={syncing}>
        {syncing ? "同步中…" : "重新同步"}
      </button>
      {warningTotal > 0 && <small>{warningTotal} 条扫描提示</small>}
    </div>
  );
}
