'use client';

import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { memo, type ComponentProps } from 'react';
import { Streamdown } from 'streamdown';

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { cjk, code };

/**
 * AI Elements 的消息正文渲染器。
 * 只保留知萃实际使用的 Markdown 能力，避免把另一套聊天状态和控件带进项目。
 */
export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={[
        'size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      ].filter(Boolean).join(' ')}
      data-ai-elements="message-response"
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (previous, next) => (
    previous.children === next.children
    && previous.isAnimating === next.isAnimating
  ),
);

MessageResponse.displayName = 'MessageResponse';
