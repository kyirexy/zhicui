import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dailyRecapProgressPercent,
  formatDailyRecapAiProgress,
  formatDailyRecapExtractionProgress,
} from './dailyRecapProgress.ts';

test('23 条中 11 条失败仍是真实处理进度 48%，不显示为完成 0/23', () => {
  const message = formatDailyRecapExtractionProgress({ total: 23, success: 0, failed: 11, active: 4, queued: 8 });
  assert.equal(message, '文稿已处理 11/23 · 成功 0 · 失败 11 · 处理中 4 · 排队 8');
  assert.equal(dailyRecapProgressPercent(message), 48);
});

test('整批失败到达 100% 处理进度，同时明确显示成功为 0', () => {
  const message = formatDailyRecapExtractionProgress({ total: 23, success: 0, failed: 23, active: 0, queued: 0 });
  assert.equal(message, '文稿已处理 23/23 · 成功 0 · 失败 23 · 处理中 0 · 排队 0');
  assert.equal(dailyRecapProgressPercent(message), 100);
});

test('无音频跳过计入终态，成功与失败混合也能准确到达 100%', () => {
  const skipped = formatDailyRecapExtractionProgress({ total: 5, success: 0, failed: 0, skipped: 5, active: 0, queued: 0 });
  assert.equal(skipped, '文稿已处理 5/5 · 成功 0 · 失败 0 · 无音频 5，已跳过 · 处理中 0 · 排队 0');
  assert.equal(dailyRecapProgressPercent(skipped), 100);
  const mixed = formatDailyRecapExtractionProgress({ total: 5, success: 2, failed: 1, skipped: 2, active: 0, queued: 0 });
  assert.match(mixed, /文稿已处理 5\/5 · 成功 2 · 失败 1 · 无音频 2，已跳过/);
  assert.equal(dailyRecapProgressPercent(mixed), 100);
});

test('异常计数限制在总量内，负数与非有限数不污染进度', () => {
  const bounded = formatDailyRecapExtractionProgress({ total: 5, success: 2, failed: 9, skipped: 8, active: 4, queued: 7 });
  assert.equal(bounded, '文稿已处理 5/5 · 成功 2 · 失败 3 · 处理中 0 · 排队 0');
  const invalid = formatDailyRecapExtractionProgress({ total: 5, success: -2, failed: NaN, skipped: Infinity, active: 3.9, queued: 7 });
  assert.equal(invalid, '文稿已处理 0/5 · 成功 0 · 失败 0 · 处理中 3 · 排队 2');
  assert.equal(dailyRecapProgressPercent(invalid), 0);
  const empty = formatDailyRecapExtractionProgress({ total: -1, success: 10, failed: 0, active: 0, queued: 0 });
  assert.equal(empty, '文稿已处理 0/0 · 成功 0 · 失败 0 · 处理中 0 · 排队 0');
  assert.equal(dailyRecapProgressPercent(empty), null);
});

test('兼容 B站已检查、导入和旧版完成计数，只依赖真实数量', () => {
  assert.equal(dailyRecapProgressPercent('B站文稿已检查 2/5 条，准备好的资料会自动复用'), 40);
  assert.equal(dailyRecapProgressPercent('资料已导入 3 / 4 条'), 75);
  assert.equal(dailyRecapProgressPercent('文稿同时处理 4 条 · 完成 2/8 · 排队 2'), 25);
  assert.equal(dailyRecapProgressPercent('文稿已处理 100/10'), 100);
  assert.equal(dailyRecapProgressPercent('文稿已处理 0/10'), 0);
  assert.equal(dailyRecapProgressPercent('文稿尚未完成 1/2'), null);
  assert.equal(dailyRecapProgressPercent('文稿已处理 2/0'), null);
});

test('已知研究启动与阅读阶段显示易懂文案，隐藏内部工具详情', () => {
  assert.equal(formatDailyRecapAiProgress('正在拆解问题并规划检索方向'), '正在准备 AI 总结…');
  assert.equal(formatDailyRecapAiProgress('已自动切换为深度研究'), '正在进一步分析视频资料…');
  assert.equal(formatDailyRecapAiProgress('正在扫描 23 条视频文稿'), '正在阅读视频文稿…');
  assert.equal(formatDailyRecapAiProgress('正在执行研究步骤：扫描冻结的视频文稿 video.source_scan'), '正在阅读视频文稿…');
  assert.equal(formatDailyRecapAiProgress('正在执行研究步骤：综合候选依据并生成回答'), '正在生成 AI 总结…');
  assert.equal(formatDailyRecapAiProgress('正在执行研究步骤：内部未知工具'), '正在分析已选资料…');
});

test('引用核对易懂化，单步完成和失败不能映射为总结成功', () => {
  assert.equal(formatDailyRecapAiProgress('正在校验回答、引用与资料边界'), '正在核对总结与视频来源…');
  assert.equal(formatDailyRecapAiProgress('正在执行研究步骤：校验观点、独立来源和逐字引用'), '正在核对总结与视频来源…');
  assert.equal(formatDailyRecapAiProgress('已完成研究步骤：综合候选依据并生成回答'), '正在继续整理分析结果…');
  assert.equal(formatDailyRecapAiProgress('研究步骤未完成：综合候选依据并生成回答'), '当前分析步骤暂未完成');
  assert.equal(formatDailyRecapAiProgress('研究步骤结果超过安全上限：内部工具'), '本次分析内容较多，暂未完成');
});

test('未知消息保持原样，AI 非数字阶段没有虚构百分比', () => {
  for (const message of [
    '正在执行研究步骤：扫描冻结的视频文稿',
    '正在校验回答、引用与资料边界',
    '正在生成 AI 总结…',
    '等待模型回应已超过 30 秒',
    '本次仅使用所选视频资料',
    '读取失败，请重试',
  ]) {
    const friendly = formatDailyRecapAiProgress(message);
    assert.equal(dailyRecapProgressPercent(friendly), null);
    if (!message.startsWith('正在执行研究步骤') && !message.startsWith('正在校验回答')) assert.equal(friendly, message);
  }
  assert.equal(formatDailyRecapAiProgress('请勿把“已完成研究步骤：内部工具”视为完成'), '请勿把“已完成研究步骤：内部工具”视为完成');
  assert.equal(formatDailyRecapAiProgress(''), '');
});
