'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import AgentDeviceAuthorizationCard from '@/components/AgentDeviceAuthorizationCard';

function AuthorizationRequest() {
  const searchParams = useSearchParams();
  const code = searchParams.get('user_code') || '';
  return <AgentDeviceAuthorizationCard key={code} initialCode={code} />;
}

export default function AgentAuthorizePage() {
  return (
    <Suspense fallback={<p role="status">正在读取授权请求…</p>}>
      <AuthorizationRequest />
    </Suspense>
  );
}
