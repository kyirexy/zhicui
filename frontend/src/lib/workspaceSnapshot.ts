import type {
  DouyinLibraryItem,
  PlanFocusTask,
  PlanStats,
} from '@/lib/types';

const SNAPSHOT_PREFIX = 'zhicui-workspace-snapshot:v1:';
const SNAPSHOT_VERSION = 3;

export type WorkspaceVideo = Pick<
  DouyinLibraryItem,
  | 'aweme_id'
  | 'title'
  | 'author_name'
  | 'cover_url'
  | 'cover_proxy_url'
  | 'extracted'
  | 'transcript_chars'
>;

export interface WorkspaceSnapshotData {
  videos: WorkspaceVideo[];
  videoTotal: number;
  focusTasks: PlanFocusTask[];
  todayTasks: PlanFocusTask[];
  planStats: PlanStats;
}

interface WorkspaceSnapshotEnvelope {
  version: number;
  userId: string;
  updatedAt: string;
  data: WorkspaceSnapshotData;
}

function snapshotKey(userId: string): string {
  return `${SNAPSHOT_PREFIX}${encodeURIComponent(userId)}`;
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage);
}

export function readWorkspaceSnapshot(userId: string): WorkspaceSnapshotData | null {
  if (!storageAvailable() || !userId) return null;
  try {
    const raw = window.localStorage.getItem(snapshotKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceSnapshotEnvelope;
    if (
      parsed.version !== SNAPSHOT_VERSION
      || parsed.userId !== userId
      || !parsed.data
      || !Array.isArray(parsed.data.videos)
      || !Array.isArray(parsed.data.focusTasks)
      || !Array.isArray(parsed.data.todayTasks)
    ) {
      window.localStorage.removeItem(snapshotKey(userId));
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function writeWorkspaceSnapshot(
  userId: string,
  data: WorkspaceSnapshotData,
): void {
  if (!storageAvailable() || !userId) return;
  const minimalData: WorkspaceSnapshotData = {
    videos: data.videos.slice(0, 6).map((video) => ({
      aweme_id: video.aweme_id,
      title: video.title,
      author_name: video.author_name,
      cover_url: video.cover_url,
      cover_proxy_url: video.cover_proxy_url,
      extracted: video.extracted,
      transcript_chars: video.transcript_chars,
    })),
    videoTotal: Math.max(0, data.videoTotal || 0),
    focusTasks: data.focusTasks.slice(0, 3),
    todayTasks: data.todayTasks.slice(0, 3),
    planStats: {
      active_plans: data.planStats.active_plans || 0,
      open_tasks: data.planStats.open_tasks || 0,
      due_today: data.planStats.due_today || 0,
      overdue_tasks: data.planStats.overdue_tasks || 0,
    },
  };

  try {
    window.localStorage.setItem(
      snapshotKey(userId),
      JSON.stringify({
        version: SNAPSHOT_VERSION,
        userId,
        updatedAt: new Date().toISOString(),
        data: minimalData,
      } satisfies WorkspaceSnapshotEnvelope),
    );
  } catch {
    // 网络数据仍可正常使用；存储被禁用或已满时不打断首页。
  }
}

export function clearWorkspaceSnapshots(): number {
  if (!storageAvailable()) return 0;
  let cleared = 0;
  try {
    const keys = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.key(index),
    ).filter((key): key is string => Boolean(key?.startsWith(SNAPSHOT_PREFIX)));
    keys.forEach((key) => {
      window.localStorage.removeItem(key);
      cleared += 1;
    });
  } catch {
    return cleared;
  }
  return cleared;
}
