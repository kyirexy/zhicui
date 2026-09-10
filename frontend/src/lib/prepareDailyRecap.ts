import {
  createAgentThread, getAgentThread, getDouyinBatchExtraction,
  importPlatformLibraryItems, resumeAgentTurnStream, startDouyinBatchExtraction,
  streamAgentMessage,
} from './api';
import { readStoredToken } from './authSession';
import { getDailyRecap, type DailyRecap } from './dailyRecapApi';
import type { AgentThread, ApiResponse, DouyinBatchExtractionJob } from './types';

interface Preparation {
  scope: string[];
  jobId?: string;
  threadId?: string;
  clientTurnId?: string;
  turnId?: string;
  sent?: boolean;
  complete?: boolean;
}

// 只保存任务标识，不缓存正文、媒体链接或身份令牌。浏览器禁用存储时仍可在本页续跑。
const memory = new Map<string, Preparation>();
const running = new Set<string>();
function read(key: string): Preparation | undefined {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || memory.get(key); }
  catch { return memory.get(key); }
}
function save(key: string, value: Preparation) {
  memory.set(key, { ...value });
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储受限时保留内存任务。 */ }
}
function data<T>(result: ApiResponse<T>, fallback: string): T {
  if (!result.success || !result.data) throw new Error(result.error || fallback);
  return result.data;
}
function pause(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(new Error('已暂停等待，后台已开始的文稿任务会保留')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, 1200);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

/** 一次提交整批文稿，复用已保存的任务，再把准备好的资料交给同一个 AI 会话。 */
export async function prepareDailyRecap(
  recap: DailyRecap,
  onProgress: (message: string) => void,
  signal: AbortSignal | undefined,
  userId: string,
): Promise<{ href: string }> {
  const token = readStoredToken();
  const check = () => {
    if (!token || readStoredToken() !== token) throw new Error('账号已切换，请在当前账号重新打开昨日回顾');
    if (signal?.aborted) throw new Error('已暂停等待，已完成的文稿会保留');
  };
  check();
  const key = `zhicui:daily-recap:v1:${userId}:${recap.date}:${recap.timezone}`;
  if (running.has(key)) throw new Error('这份回顾正在处理中，请等待当前任务');
  running.add(key);
  try {
    // 每次点击重新确认可见来源；日期固定，跨午夜也不会换成另一天。
    let fresh = await getDailyRecap(recap.timezone, signal, recap.date);
    check();
    const originalIds = new Set(recap.items.map((item) => item.id));
    const selected = fresh.items.filter((item) => originalIds.has(item.id));
    if (!selected.length) throw new Error('这些资料已不在当前回顾中，请刷新后重试');
    const scope = selected.map((item) => item.id).sort();
    const previous = read(key);
    const state: Preparation = previous && JSON.stringify(previous.scope) === JSON.stringify(scope)
      ? previous : { scope };
    save(key, state);
    const href = () => ({ href: `/harness?thread=${encodeURIComponent(state.threadId!)}` });
    let reusableThread: AgentThread | undefined;

    if (state.threadId) {
      const result = await getAgentThread(state.threadId);
      check();
      if (result.success && result.data) {
        if (state.complete) return href();
        if (state.turnId) {
          onProgress('正在恢复已有 AI 回顾…');
          check();
          const resumed = await resumeAgentTurnStream(state.threadId, state.turnId, {
            onProgress: (event) => { check(); onProgress(event.message); },
          }, signal);
          check();
          // 失败/取消的持久任务仍能打开原会话查看原因或手动重试。
          // 恢复流失败不能把首页困在重试循环，也不能自动再次收费生成。
          if (!resumed.success || !resumed.data) return href();
          state.complete = true;
          save(key, state);
          return href();
        }
        // 兼容旧版 AI 流：响应中断时先打开原会话，不能自动再次产生同一笔请求。
        if (state.sent) return href();
        if (result.data.message_count > 0 || result.data.active_turn) {
          // 已从其他入口使用的会话不再自动补发回顾。
          state.sent = true;
          save(key, state);
          return href();
        }
        reusableThread = result.data;
      } else if (result.status === 404) {
        delete state.threadId; delete state.turnId; delete state.sent; delete state.complete;
        delete state.clientTurnId;
        save(key, state);
      } else {
        throw new Error(result.error || '已有回顾暂时无法读取，请重试');
      }
    }

    let job: DouyinBatchExtractionJob | undefined;
    if (state.jobId) {
      const result = await getDouyinBatchExtraction(state.jobId, signal);
      check();
      if (result.success && result.data) job = result.data;
      else if (result.status !== 404) throw new Error(result.error || '已有文稿任务暂时无法读取，请重试');
    }
    const missing = selected.filter((item) => !item.transcript_ready && item.can_extract);
    if (!job) {
      const ids = [...new Set(missing.filter((item) => item.platform === 'douyin').map((item) => item.video_id))];
      if (ids.length) {
        check();
        job = data(await startDouyinBatchExtraction(ids, 'transcript'), '文稿提取未能启动');
        state.jobId = job.job_id;
        save(key, state);
        check();
      }
    }
    const waitDouyin = async () => {
      while (job?.status === 'running') {
        check();
        onProgress(`文稿同时处理 ${job.active} 条 · 完成 ${job.success}/${job.total} · 排队 ${job.queued}`);
        await pause(signal);
        check();
        job = data(await getDouyinBatchExtraction(job.job_id, signal), '读取文稿任务失败，已完成的文稿会保留');
      }
    };
    // B站通常导入时已有字幕；残缺旧资料用已有导入入口补齐，不传来源排序参数。
    const bili = missing.filter((item) => item.platform === 'bilibili');
    let next = 0;
    let biliCompleted = 0;
    const prepareBili = async () => {
      while (next < bili.length) {
        check();
        const item = bili[next++];
        try { await importPlatformLibraryItems([item.source_url]); }
        catch { check(); /* 单条读取失败后继续，最终只使用再次确认已就绪的资料。 */ }
        check();
        onProgress(`B站文稿已检查 ${++biliCompleted}/${bili.length} 条，准备好的资料会自动复用`);
      }
    };
    await Promise.all([waitDouyin(), ...Array.from({ length: Math.min(4, bili.length) }, prepareBili)]);
    check();
    delete state.jobId;
    save(key, state);
    fresh = await getDailyRecap(recap.timezone, signal, recap.date);
    check();
    const selectedIds = new Set(scope);
    const visible = fresh.items.filter((item) => selectedIds.has(item.id));
    const ready = visible.filter((item) => item.transcript_ready && item.note_id);
    const noteIds = [...new Set(ready.map((item) => item.note_id!))];
    if (!noteIds.length) throw new Error('本次文稿尚未就绪，请重试；已有视频和同步记录会保留');
    const unavailable = selected.length - ready.length;
    onProgress(unavailable > 0
      ? `${noteIds.length} 条文稿已就绪，${unavailable} 条暂不可用；正在生成已就绪资料的回顾…`
      : `${noteIds.length} 条文稿已就绪，正在生成 AI 回顾…`);
    check();
    // 创建后离开页面可能尚未发送；重新确认来源完全一致后复用空会话。
    // 可见资料或 Note 标识发生变化时，旧会话不能继续带入失效来源。
    const sameSources = reusableThread?.source_scope === 'selected'
      && JSON.stringify([...new Set(reusableThread.source_ids)].sort()) === JSON.stringify([...noteIds].sort());
    const thread = sameSources ? reusableThread! : data(await createAgentThread({
      title: `${recap.date} 昨日回顾`, source_scope: 'selected', source_ids: noteIds,
    }), '回顾会话未能创建，已提取文稿会保留');
    state.threadId = thread.id;
    if (!sameSources || !state.clientTurnId) state.clientTurnId = crypto.randomUUID();
    save(key, state);
    check();
    const content = `请根据本会话选中的 ${noteIds.length} 条视频资料，整理 ${recap.date} 的「昨日回顾」。\n`
      + '统计依据是当天首次同步到知萃的点赞与收藏，不代表当天实际点赞收藏，也不代表视频发布时间；首次导入可能包含历史视频。\n'
      + `当天记录共 ${fresh.total} 条，本次选择 ${selected.length} 条；${unavailable} 条未就绪或已不可见，请明确说明覆盖范围，不要假装已经读过。\n`
      + '先按主题归类，提炼共同观点和不同意见，再给出最值得记住的要点及 3 个可执行的小行动。重要结论引用具体视频来源；证据不足请明确说明。最后给出 3 个适合继续追问的问题。不要逐条机械复述，也不要联网补充未选中的资料。';
    state.sent = true;
    save(key, state);
    const result = await streamAgentMessage(thread.id, {
      content, client_turn_id: state.clientTurnId, research_mode: 'auto',
      output_style: 'summary', web_scope: 'video_only',
    }, {
      onTurn: (turnId) => { state.turnId = turnId; save(key, state); },
      onProgress: (event) => { check(); onProgress(event.message); },
    }, signal);
    check();
    data(result, 'AI 回顾暂未完成，已保存会话，可继续打开');
    state.complete = true;
    save(key, state);
    return href();
  } finally { running.delete(key); }
}
