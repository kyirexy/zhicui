'use client';

import { Brain, Cloud, Cpu } from '@phosphor-icons/react';
import Anthropic from '@lobehub/icons/es/Anthropic/components/Mono';
import AzureAI from '@lobehub/icons/es/AzureAI/components/Color';
import BaiduCloud from '@lobehub/icons/es/BaiduCloud/components/Color';
import Bedrock from '@lobehub/icons/es/Bedrock/components/Color';
import Claude from '@lobehub/icons/es/Claude/components/Color';
import Cohere from '@lobehub/icons/es/Cohere/components/Color';
import DeepSeek from '@lobehub/icons/es/DeepSeek/components/Color';
import Doubao from '@lobehub/icons/es/Doubao/components/Color';
import Gemini from '@lobehub/icons/es/Gemini/components/Color';
import Grok from '@lobehub/icons/es/Grok/components/Mono';
import Groq from '@lobehub/icons/es/Groq/components/Mono';
import HuggingFace from '@lobehub/icons/es/HuggingFace/components/Color';
import Hunyuan from '@lobehub/icons/es/Hunyuan/components/Color';
import Kimi from '@lobehub/icons/es/Kimi/components/Mono';
import MetaAI from '@lobehub/icons/es/MetaAI/components/Color';
import Minimax from '@lobehub/icons/es/Minimax/components/Color';
import Mistral from '@lobehub/icons/es/Mistral/components/Color';
import Nvidia from '@lobehub/icons/es/Nvidia/components/Color';
import Ollama from '@lobehub/icons/es/Ollama/components/Mono';
import OpenAI from '@lobehub/icons/es/OpenAI/components/Mono';
import OpenCode from '@lobehub/icons/es/OpenCode/components/Mono';
import OpenRouter from '@lobehub/icons/es/OpenRouter/components/Color';
import Perplexity from '@lobehub/icons/es/Perplexity/components/Color';
import Qwen from '@lobehub/icons/es/Qwen/components/Color';
import SiliconCloud from '@lobehub/icons/es/SiliconCloud/components/Color';
import VertexAI from '@lobehub/icons/es/VertexAI/components/Color';
import Volcengine from '@lobehub/icons/es/Volcengine/components/Color';
import XiaomiMiMo from '@lobehub/icons/es/XiaomiMiMo/components/Mono';
import Zhipu from '@lobehub/icons/es/Zhipu/components/Color';
import { resolveModelBrand, type ModelBrandIdentity } from '@/lib/modelBrand';

interface AIModelIconProps extends ModelBrandIdentity {
  className?: string;
  size?: number;
}

export default function AIModelIcon({
  className,
  size = 18,
  ...identity
}: AIModelIconProps) {
  const props = { 'aria-hidden': true as const, className, size };
  switch (resolveModelBrand(identity)) {
    case 'openai': return <OpenAI {...props} style={{ color: 'var(--foreground)' }} />;
    case 'claude': return <Claude {...props} />;
    case 'anthropic': return <Anthropic {...props} style={{ color: '#D97757' }} />;
    case 'gemini': return <Gemini {...props} />;
    case 'deepseek': return <DeepSeek {...props} />;
    case 'mimo': return <XiaomiMiMo {...props} style={{ color: '#FF6900' }} />;
    case 'hunyuan': return <Hunyuan {...props} />;
    case 'felo':
      return (
        <img
          aria-hidden="true"
          alt=""
          className={className}
          height={size}
          src="https://felo.ai/icon.svg"
          style={{
            borderRadius: '32%',
            flex: '0 0 auto',
            height: size,
            objectFit: 'contain',
            width: size,
          }}
          width={size}
        />
      );
    case 'qwen': return <Qwen {...props} />;
    case 'doubao': return <Doubao {...props} />;
    case 'kimi': return <Kimi {...props} style={{ color: 'var(--foreground)' }} />;
    case 'minimax': return <Minimax {...props} />;
    case 'mistral': return <Mistral {...props} />;
    case 'meta': return <MetaAI {...props} />;
    case 'grok': return <Grok {...props} style={{ color: 'var(--foreground)' }} />;
    case 'groq': return <Groq {...props} style={{ color: '#F55036' }} />;
    case 'nvidia': return <Nvidia {...props} />;
    case 'ollama': return <Ollama {...props} style={{ color: 'var(--foreground)' }} />;
    case 'siliconcloud': return <SiliconCloud {...props} />;
    case 'openrouter': return <OpenRouter {...props} />;
    case 'opencode': return <OpenCode {...props} />;
    case 'cohere': return <Cohere {...props} />;
    case 'huggingface': return <HuggingFace {...props} />;
    case 'perplexity': return <Perplexity {...props} />;
    case 'azure': return <AzureAI {...props} />;
    case 'bedrock': return <Bedrock {...props} />;
    case 'vertex': return <VertexAI {...props} />;
    case 'baidu': return <BaiduCloud {...props} />;
    case 'volcengine': return <Volcengine {...props} />;
    case 'zhipu': return <Zhipu {...props} />;
    case 'custom': return <Cloud {...props} weight="duotone" />;
    case 'platform': return <Brain {...props} weight="duotone" />;
    default: return <Cpu {...props} weight="duotone" />;
  }
}
