'use client';

import { Suspense } from 'react';
import VideoKnowledgeWorkspace from '@/components/VideoKnowledgeWorkspace';
import styles from './LibraryDetail.module.css';

function WorkspaceLoading() {
  return (
    <div className="video-knowledge-loading" role="status">
      <span className="video-knowledge-loading-mark" aria-hidden />
      <strong>正在打开视频资料</strong>
    </div>
  );
}

export default function VideoKnowledgeDetailPage() {
  return (
    <div className={styles.page}>
      <Suspense fallback={<WorkspaceLoading />}>
        <VideoKnowledgeWorkspace />
      </Suspense>
    </div>
  );
}
