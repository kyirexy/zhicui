'use client';

import { useEffect, useMemo, useState } from 'react';
import { ScanSearch } from 'lucide-react';
import {
  cancelVideoAnalysisRun,
  confirmVideoAnalysisRun,
  getVideoAnalysisCatalog,
  getVideoAnalysisAccount,
  prepareVideoAnalysis,
} from '@/lib/api';
import { useVideoAnalysis } from '@/lib/hooks/VideoAnalysisContext';
import type {
  VideoAnalysisCatalog,
  VideoAnalysisOffering,
  VideoAnalysisPrepareResult,
} from '@/lib/types';
import {
  createVideoAnalysisIdempotencyKey,
  recommendedOffering,
} from '@/lib/videoAnalysis';
import VideoAnalysisQuoteSheet from './VideoAnalysisQuoteSheet';

interface VideoAnalysisBatchActionProps {
  noteIds: string[];
  selectedCount: number;
  unsupportedCount: number;
  disabled?: boolean;
  onStarted?: (cachedOnly?: boolean) => void;
  label?: string;
}

export default function VideoAnalysisBatchAction({
  noteIds,
  selectedCount,
  unsupportedCount,
  disabled = false,
  onStarted,
  label,
}: VideoAnalysisBatchActionProps) {
  const { trackRun } = useVideoAnalysis();
  const [catalog, setCatalog] = useState<VideoAnalysisCatalog | null>(null);
  const [selectedOffering, setSelectedOffering] = useState<VideoAnalysisOffering | null>(null);
  const [useByok, setUseByok] = useState(false);
  const [prepared, setPrepared] = useState<VideoAnalysisPrepareResult | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const stableNoteIds = useMemo(
    () => [...new Set(noteIds.map(id => id.trim()).filter(Boolean))],
    [noteIds],
  );
  const noteIdKey = stableNoteIds.join(',');

  useEffect(() => {
    let active = true;
    if (!stableNoteIds.length) {
      setCatalog(null);
      return undefined;
    }
    void Promise.all([
      getVideoAnalysisCatalog(stableNoteIds, 'batch'),
      getVideoAnalysisAccount(),
    ]).then(([response, accountResponse]) => {
      if (!active || !response.success || !response.data) return;
      const nextCatalog = {
        ...response.data,
        account: response.data.account || (accountResponse.success ? accountResponse.data : null),
      };
      setCatalog(nextCatalog);
      setSelectedOffering(recommendedOffering(nextCatalog));
    });
    return () => {
      active = false;
    };
    // A stable joined key prevents a new request for an equivalent array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteIdKey]);

  const prepare = async (offering: VideoAnalysisOffering, withByok: boolean) => {
    if (prepared?.run.id && prepared.run.status === 'prepared') {
      await cancelVideoAnalysisRun(prepared.run.id);
    }
    setSelectedOffering(offering);
    setUseByok(withByok);
    setPrepared(null);
    setError('');
    setSheetOpen(true);
    setPreparing(true);
    const response = await prepareVideoAnalysis({
      note_ids: stableNoteIds,
      offering_id: offering.id,
      use_byok: withByok,
      trigger: 'batch',
    });
    setPreparing(false);
    if (!response.success || !response.data) {
      setError(response.error || '批量报价失败，请稍后重试');
      return;
    }
    setPrepared(response.data);
    if (response.data.run.status === 'succeeded' || response.data.run.status === 'partial') {
      setSheetOpen(false);
      onStarted?.(true);
      return;
    }
    if (response.data.quote?.process_count === 0) {
      setError('所选资料没有可执行的详细视频解析项');
    }
  };

  const open = () => {
    const offering = selectedOffering || recommendedOffering(catalog);
    if (!offering || !stableNoteIds.length) return;
    void prepare(offering, false);
  };

  const confirm = async () => {
    if (!prepared?.run.id || confirming) return;
    setConfirming(true);
    setError('');
    const response = await confirmVideoAnalysisRun(
      prepared.run.id,
      createVideoAnalysisIdempotencyKey(prepared.run.id),
    );
    setConfirming(false);
    if (!response.success || !response.data) {
      setError(response.error || '批量解析任务启动失败，请重新报价');
      return;
    }
    setSheetOpen(false);
    trackRun(response.data);
    onStarted?.(false);
  };

  const closeSheet = async () => {
    if (confirming) return;
    setSheetOpen(false);
    if (prepared?.run.id && prepared.run.status === 'prepared') {
      await cancelVideoAnalysisRun(prepared.run.id);
      setPrepared(null);
    }
  };

  if (!stableNoteIds.length || !catalog?.enabled || !recommendedOffering(catalog)) return null;

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={disabled || preparing || confirming}
      >
        <ScanSearch size={15} aria-hidden="true" />
        {label || `详细解析已选 ${selectedCount} 条`}
      </button>
      <VideoAnalysisQuoteSheet
        open={sheetOpen}
        onClose={() => void closeSheet()}
        catalog={catalog}
        prepared={prepared}
        selectedOffering={selectedOffering}
        useByok={useByok}
        itemCount={selectedCount}
        selectedCount={selectedCount}
        unsupportedCount={unsupportedCount}
        preparing={preparing}
        confirming={confirming}
        error={error}
        onSelect={(offering, withByok) => void prepare(offering, withByok)}
        onConfirm={() => void confirm()}
      />
    </>
  );
}
