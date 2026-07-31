import type { SVGProps } from 'react';

const AGENT_MARK_SIZES = {
  nav: 20,
  avatar: 16,
  hero: 28,
} as const;

export type AgentMarkVariant = keyof typeof AGENT_MARK_SIZES;

export interface AgentMarkProps
  extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  variant?: AgentMarkVariant;
  size?: number;
  title?: string;
}

/**
 * 知萃 Agent 的统一标识：两片叶形书页代表视频知识，
 * 中间的校验勾代表回答经过资料核对。
 */
export default function AgentMark({
  variant = 'nav',
  size,
  title,
  ...svgProps
}: AgentMarkProps) {
  const resolvedSize = size ?? AGENT_MARK_SIZES[variant];

  return (
    <svg
      {...svgProps}
      xmlns="http://www.w3.org/2000/svg"
      width={resolvedSize}
      height={resolvedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={variant === 'avatar' ? 2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d="M12 18.8C9.9 17 7.3 16.1 4.1 16.1V4.8c3.5.1 6.2 1.6 7.9 4.1" />
      <path d="M12 18.8c2.1-1.8 4.7-2.7 7.9-2.7V4.8c-3.5.1-6.2 1.6-7.9 4.1" />
      <path d="M12 8.9v9.9" />
      <path d="m8.1 11.7 1.8 1.8 4.4-4.5" />
    </svg>
  );
}
