'use client';

import { Suspense } from 'react';
import VideoKnowledgeWorkspace from '@/components/VideoKnowledgeWorkspace';

function WorkspaceLoading() {
  return (
    <div className="video-knowledge-loading" role="status">
      <span className="video-knowledge-loading-mark" aria-hidden />
      <strong>正在打开视频知识工作区</strong>
      <span>读取视频、完整文案与行动计划</span>
    </div>
  );
}

export default function VideoKnowledgeDetailPage() {
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <VideoKnowledgeWorkspace />
    </Suspense>
  );
}
