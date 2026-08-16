'use client';

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import {
  Brain,
  CaretDown,
  Check,
  Cloud,
  Cpu,
  FolderOpen,
  Gift,
  MagnifyingGlass,
  PaperPlaneTilt,
  SlidersHorizontal,
  Stop,
} from '@phosphor-icons/react';
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
import Zhipu from '@lobehub/icons/es/Zhipu/components/Color';
import AgentOptionsSheet from '@/components/agent/AgentOptionsSheet';
import type {
  UserAIProviderConfig,
  UserChatModel,
} from '@/lib/api';
import type {
  LibraryOutputStyle,
  LibraryResearchMode,
  ResearchScope,
} from '@/lib/types';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';

export interface AgentComposerHandle {
  clear: () => void;
  focus: () => void;
  getValue: () => string;
  setValue: (value: string) => void;
}

interface AgentComposerProps {
  activeSourceCount: number;
  accountPoints: number;
  aiProviderConfig: UserAIProviderConfig | null;
  availableModels: UserChatModel[];
  backgroundActive: boolean;
  customInstruction: string;
  modelCatalogLoading: boolean;
  modelError: string;
  modelSaving: boolean;
  outputLabel: string;
  outputStyle: LibraryOutputStyle;
  researchMode: LibraryResearchMode;
  researchLabel: string;
  selectedModel: string;
  sourceLabel: string;
  sourcesExpanded?: boolean;
  statusMessage: string;
  webLabel: string;
  webScope: ResearchScope;
  sending: boolean;
  onChangeCustomInstruction: (value: string) => void;
  onChangeModel: (modelId: string) => void;
  onOpenSources: (trigger: HTMLButtonElement) => void;
  onApplyOptions: (
    researchMode: LibraryResearchMode,
    outputStyle: LibraryOutputStyle,
    webScope: ResearchScope,
  ) => void;
  onStop: () => void;
  onSubmitQuestion: (content: string) => void;
}

interface ComposerModelOption {
  id: string;
  name: string;
  provider: string;
  free: boolean;
  points: number;
  detail: string;
}

interface ComposerModelGroup {
  id: string;
  label: string;
  options: ComposerModelOption[];
}

type ModelMenuPosition = Pick<CSSProperties, 'bottom' | 'left' | 'width'>;

const MODEL_GROUPS = [
  { id: 'platform', label: '平台模型' },
  { id: 'custom', label: '我的模型' },
] as const;

function getModelIdentity(option: ComposerModelOption) {
  return `${option.id} ${option.name} ${option.provider}`.toLocaleLowerCase('zh-CN');
}

function getModelGroupId(option: ComposerModelOption): typeof MODEL_GROUPS[number]['id'] {
  return option.id === '__custom__' ? 'custom' : 'platform';
}

function ComposerModelIcon({
  option,
  size = 16,
}: {
  option: ComposerModelOption;
  size?: number;
}) {
  const identity = getModelIdentity(option);

  if (identity.includes('openai') || identity.includes('gpt')) {
    return <OpenAI size={size} style={{ color: 'var(--foreground)' }} aria-hidden="true" />;
  }
  if (identity.includes('claude')) {
    return <Claude size={size} aria-hidden="true" />;
  }
  if (identity.includes('anthropic')) {
    return <Anthropic size={size} style={{ color: '#D97757' }} aria-hidden="true" />;
  }
  if (identity.includes('gemini') || identity.includes('google')) {
    return <Gemini size={size} aria-hidden="true" />;
  }
  if (identity.includes('deepseek') || identity.includes('深度求索')) {
    return <DeepSeek size={size} aria-hidden="true" />;
  }
  if (identity.includes('qwen') || identity.includes('千问') || identity.includes('通义')) {
    return <Qwen size={size} aria-hidden="true" />;
  }
  if (identity.includes('doubao') || identity.includes('豆包')) {
    return <Doubao size={size} aria-hidden="true" />;
  }
  if (identity.includes('kimi') || identity.includes('moonshot') || identity.includes('月之暗面')) {
    return <Kimi size={size} style={{ color: 'var(--foreground)' }} aria-hidden="true" />;
  }
  if (identity.includes('minimax') || identity.includes('海螺')) {
    return <Minimax size={size} aria-hidden="true" />;
  }
  if (identity.includes('mistral')) {
    return <Mistral size={size} aria-hidden="true" />;
  }
  if (identity.includes('llama') || identity.includes('meta ai') || identity.includes('meta-ai')) {
    return <MetaAI size={size} aria-hidden="true" />;
  }
  if (identity.includes('grok') || identity.includes('xai')) {
    return <Grok size={size} style={{ color: 'var(--foreground)' }} aria-hidden="true" />;
  }
  if (identity.includes('groq')) {
    return <Groq size={size} style={{ color: '#F55036' }} aria-hidden="true" />;
  }
  if (identity.includes('nvidia') || identity.includes('nemotron')) {
    return <Nvidia size={size} aria-hidden="true" />;
  }
  if (identity.includes('ollama')) {
    return <Ollama size={size} style={{ color: 'var(--foreground)' }} aria-hidden="true" />;
  }
  if (identity.includes('siliconflow') || identity.includes('silicon cloud') || identity.includes('硅基流动')) {
    return <SiliconCloud size={size} aria-hidden="true" />;
  }
  if (identity.includes('openrouter')) {
    return <OpenRouter size={size} aria-hidden="true" />;
  }
  if (identity.includes('opencode')) {
    return <OpenCode size={size} aria-hidden="true" />;
  }
  if (identity.includes('cohere') || identity.includes('command-r')) {
    return <Cohere size={size} aria-hidden="true" />;
  }
  if (identity.includes('huggingface') || identity.includes('hugging face')) {
    return <HuggingFace size={size} aria-hidden="true" />;
  }
  if (identity.includes('perplexity')) {
    return <Perplexity size={size} aria-hidden="true" />;
  }
  if (identity.includes('azure')) {
    return <AzureAI size={size} aria-hidden="true" />;
  }
  if (identity.includes('bedrock')) {
    return <Bedrock size={size} aria-hidden="true" />;
  }
  if (identity.includes('vertex')) {
    return <VertexAI size={size} aria-hidden="true" />;
  }
  if (identity.includes('baidu') || identity.includes('ernie') || identity.includes('文心')) {
    return <BaiduCloud size={size} aria-hidden="true" />;
  }
  if (identity.includes('volcengine') || identity.includes('火山引擎')) {
    return <Volcengine size={size} aria-hidden="true" />;
  }
  if (identity.includes('zhipu') || identity.includes('glm') || identity.includes('智谱')) {
    return <Zhipu size={size} aria-hidden="true" />;
  }
  if (option.id === '__custom__') {
    return <Cloud size={size} weight="duotone" aria-hidden="true" />;
  }
  if (option.id === '__platform__') {
    return <Brain size={size} weight="duotone" aria-hidden="true" />;
  }
  return <Cpu size={size} weight="duotone" aria-hidden="true" />;
}

const AgentComposer = memo(forwardRef<AgentComposerHandle, AgentComposerProps>(
  function AgentComposer({
    activeSourceCount,
    accountPoints,
    aiProviderConfig,
    availableModels,
    backgroundActive,
    customInstruction,
    modelCatalogLoading,
    modelError,
    modelSaving,
    outputLabel,
    outputStyle,
    researchMode,
    researchLabel,
    selectedModel,
    sourceLabel,
    sourcesExpanded,
    statusMessage,
    webLabel,
    webScope,
    sending,
    onChangeCustomInstruction,
    onChangeModel,
    onOpenSources,
    onApplyOptions,
    onStop,
    onSubmitQuestion,
  }, ref) {
    const isMobile = useIsMobile();
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const modelPickerRef = useRef<HTMLDivElement | null>(null);
    const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
    const optionsPickerRef = useRef<HTMLDivElement | null>(null);
    const optionsTriggerRef = useRef<HTMLButtonElement | null>(null);
    const [question, setQuestion] = useState('');
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [modelMenuPosition, setModelMenuPosition] = useState<ModelMenuPosition | null>(null);
    const [modelQuery, setModelQuery] = useState('');
    const [optionsOpen, setOptionsOpen] = useState(false);
    const [draftResearchMode, setDraftResearchMode] = useState(researchMode);
    const [draftOutputStyle, setDraftOutputStyle] = useState(outputStyle);
    const [draftWebScope, setDraftWebScope] = useState(webScope);

    const modelOptions = useMemo<ComposerModelOption[]>(() => {
      const options: ComposerModelOption[] = [];
      availableModels.forEach((item) => options.push({
        id: item.id,
        name: item.name,
        provider: '知萃平台',
        free: item.is_free,
        points: item.points_per_request,
        detail: item.is_free
          ? item.free_daily_limit === 0
            ? '已包含 · 不限次数'
            : `今日可用 ${item.free_remaining_today ?? 0}/${item.free_daily_limit} 次`
          : `${item.points_per_request} 萃点/次`,
      }));
      if (aiProviderConfig?.mode === 'custom') {
        options.push({
          id: '__custom__',
          name: aiProviderConfig.model,
          provider: aiProviderConfig.provider_name || '自带供应商',
          free: false,
          points: 0,
          detail: '使用你的 API Key',
        });
      }
      return options;
    }, [aiProviderConfig, availableModels]);

    const selectedModelOption = modelOptions.find((option) => option.id === selectedModel)
      || modelOptions[0]
      || { id: '', name: '暂无可用模型', provider: '知萃平台', free: false, points: 0, detail: '' };
    const filteredModelOptions = useMemo(() => {
      const query = modelQuery.trim().toLocaleLowerCase('zh-CN');
      if (!query) return modelOptions;
      return modelOptions.filter((option) => (
        `${option.name} ${option.provider}`.toLocaleLowerCase('zh-CN').includes(query)
      ));
    }, [modelOptions, modelQuery]);
    const groupedModelOptions = useMemo<ComposerModelGroup[]>(() => {
      const optionsByGroup = new Map<string, ComposerModelOption[]>();
      filteredModelOptions.forEach((option) => {
        const groupId = getModelGroupId(option);
        optionsByGroup.set(groupId, [...(optionsByGroup.get(groupId) || []), option]);
      });
      return MODEL_GROUPS.flatMap((group) => {
        const options = optionsByGroup.get(group.id);
        return options?.length ? [{ ...group, options }] : [];
      });
    }, [filteredModelOptions]);

    const updateModelMenuPosition = useCallback(() => {
      const trigger = modelTriggerRef.current;
      if (!trigger) return;
      const viewportMargin = 14;
      const triggerRect = trigger.getBoundingClientRect();
      const width = Math.min(440, window.innerWidth - viewportMargin * 2);
      setModelMenuPosition({
        bottom: Math.max(viewportMargin, window.innerHeight - triggerRect.top + 9),
        left: Math.max(
          viewportMargin,
          Math.min(triggerRect.left, window.innerWidth - width - viewportMargin),
        ),
        width,
      });
    }, []);

    const openModelMenu = () => {
      updateModelMenuPosition();
      setModelMenuOpen(true);
    };

    const toggleModelMenu = () => {
      if (modelMenuOpen) {
        setModelMenuOpen(false);
        setModelQuery('');
        return;
      }
      openModelMenu();
    };

    useEffect(() => {
      if (!modelMenuOpen) return;
      updateModelMenuPosition();
      window.addEventListener('resize', updateModelMenuPosition);
      window.addEventListener('scroll', updateModelMenuPosition, true);
      return () => {
        window.removeEventListener('resize', updateModelMenuPosition);
        window.removeEventListener('scroll', updateModelMenuPosition, true);
      };
    }, [modelMenuOpen, updateModelMenuPosition]);

    useEffect(() => {
      if (!modelMenuOpen) return;
      const closeOnOutsideClick = (event: PointerEvent) => {
        if (!modelPickerRef.current?.contains(event.target as Node)) {
          setModelMenuOpen(false);
          setModelQuery('');
        }
      };
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setModelMenuOpen(false);
          setModelQuery('');
          modelTriggerRef.current?.focus();
        }
      };
      document.addEventListener('pointerdown', closeOnOutsideClick);
      document.addEventListener('keydown', closeOnEscape);
      return () => {
        document.removeEventListener('pointerdown', closeOnOutsideClick);
        document.removeEventListener('keydown', closeOnEscape);
      };
    }, [modelMenuOpen]);

    const chooseModel = (modelId: string) => {
      setModelMenuOpen(false);
      setModelQuery('');
      if (modelId !== selectedModel) onChangeModel(modelId);
      modelTriggerRef.current?.focus();
    };

    useImperativeHandle(ref, () => ({
      clear: () => setQuestion(''),
      focus: () => textareaRef.current?.focus(),
      getValue: () => question,
      setValue: (value: string) => setQuestion(value),
    }), [question]);

    const submit = (event: FormEvent) => {
      event.preventDefault();
      const content = question.trim();
      if (!content || sending || modelSaving || backgroundActive) return;
      onSubmitQuestion(content);
    };

    const openOptions = () => {
      setModelMenuOpen(false);
      setModelQuery('');
      setDraftResearchMode(researchMode);
      setDraftOutputStyle(outputStyle);
      setDraftWebScope(webScope);
      setOptionsOpen(true);
    };

    const closeOptions = () => {
      setOptionsOpen(false);
      onApplyOptions(draftResearchMode, draftOutputStyle, draftWebScope);
    };

    useEffect(() => {
      if (!optionsOpen) return;
      const closeOnOutsideClick = (event: PointerEvent) => {
        if (!optionsPickerRef.current?.contains(event.target as Node)) closeOptions();
      };
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          closeOptions();
          optionsTriggerRef.current?.focus();
        }
      };
      document.addEventListener('pointerdown', closeOnOutsideClick);
      document.addEventListener('keydown', closeOnEscape);
      return () => {
        document.removeEventListener('pointerdown', closeOnOutsideClick);
        document.removeEventListener('keydown', closeOnEscape);
      };
    }, [optionsOpen, draftResearchMode, draftOutputStyle, draftWebScope]);

    return (
      <>
        <footer className="video-agent-composer-region">
        <form className="video-agent-composer" onSubmit={submit}>
          <div className="video-agent-composer-status">
            <div
              ref={modelPickerRef}
              className="video-agent-model-select"
              title={isMobile ? '选择回答方式' : '选择本次对话使用的模型'}
            >
              <button
                ref={modelTriggerRef}
                type="button"
                className="video-agent-model-trigger"
                aria-label={isMobile ? '选择回答方式' : '选择回答模型'}
                aria-haspopup="listbox"
                aria-expanded={modelMenuOpen}
                aria-controls="video-agent-model-menu"
                disabled={modelCatalogLoading || modelSaving || sending || backgroundActive}
                onClick={toggleModelMenu}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    openModelMenu();
                  }
                }}
              >
                <span className="video-agent-model-trigger-icon" aria-hidden="true">
                  <ComposerModelIcon option={selectedModelOption} size={16} />
                </span>
                <strong>{modelCatalogLoading ? '正在准备回答' : selectedModelOption.name}</strong>
                <CaretDown size={12} aria-hidden="true" />
              </button>

              {modelMenuOpen && modelMenuPosition && (
                <section
                  className="video-agent-model-menu"
                  style={modelMenuPosition}
                  aria-label={isMobile ? '回答方式' : '回答模型'}
                >
                  <header>
                    <strong>{isMobile ? '选择回答方式' : '选择模型'}</strong>
                    <span>{isMobile ? '按需要选择' : `${accountPoints.toLocaleString('zh-CN')} 萃点`}</span>
                  </header>
                  <label className="video-agent-model-search">
                    <MagnifyingGlass size={15} aria-hidden="true" />
                    <input
                      autoFocus
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      placeholder={isMobile ? '搜索回答方式' : '搜索模型'}
                      aria-label={isMobile ? '搜索回答方式' : '搜索模型'}
                    />
                  </label>
                  <div id="video-agent-model-menu" className="video-agent-model-list" role="listbox">
                    {groupedModelOptions.length ? groupedModelOptions.map((group) => (
                      <section
                        key={group.id}
                        className="video-agent-model-group"
                        role="group"
                        aria-labelledby={`video-agent-model-group-${group.id}`}
                      >
                        <h3 id={`video-agent-model-group-${group.id}`}>
                          {isMobile ? (group.id === 'platform' ? '知萃推荐' : '个人选择') : group.label}
                        </h3>
                        {group.options.map((option) => {
                          const active = option.id === selectedModel;
                          return (
                            <button
                              key={option.id}
                              type="button"
                              role="option"
                              aria-selected={active}
                              className={active ? 'is-active' : ''}
                              onClick={() => chooseModel(option.id)}
                            >
                              <span className="video-agent-model-glyph" aria-hidden="true">
                                <ComposerModelIcon option={option} size={18} />
                              </span>
                              <span>
                                <strong>{option.name}</strong>
                                <small>{isMobile && option.id === '__custom__' ? '已连接' : option.detail}</small>
                              </span>
                              <em aria-label={option.free ? '已包含额度' : option.points > 0 ? `${option.points} 萃点` : '自定义模型'} title={option.free ? '已包含额度' : undefined}>
                                {option.free ? <Gift size={15} weight="duotone" aria-hidden="true" /> : option.points > 0 ? `${option.points} 萃点` : '自定义'}
                              </em>
                              {active && <Check size={15} weight="bold" aria-hidden="true" />}
                            </button>
                          );
                        })}
                      </section>
                    )) : (
                      <p>{isMobile ? '没有找到匹配的回答方式' : '没有找到匹配的模型'}</p>
                    )}
                  </div>
                </section>
              )}
            </div>
            <span className="sr-only" role="status" aria-live="polite">
              {statusMessage}
            </span>
          </div>

          {modelError && (
            <div className="video-agent-model-error" role="alert">
              {modelError}
            </div>
          )}

          <textarea
            ref={textareaRef}
            rows={2}
            maxLength={600}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter'
                && !event.shiftKey
                && !event.nativeEvent.isComposing
                && !sending
                && !modelSaving
                && !backgroundActive
              ) {
                event.preventDefault();
                onSubmitQuestion(question.trim());
              }
            }}
            placeholder={
              sending || backgroundActive
                ? '可以先写下一问，当前回答完成后再发送'
                : '问这些视频，或让知萃把结论变成计划…'
            }
            aria-label="向知萃问答提问"
          />

          {outputStyle === 'custom' && (
            <input
              className="video-agent-custom-instruction"
              value={customInstruction}
              maxLength={600}
              onChange={(event) => onChangeCustomInstruction(event.target.value)}
              placeholder="写下你希望的结构、重点或语气"
            />
          )}

          <div className="video-agent-composer-toolbar">
            <div className="video-agent-composer-controls">
              <button
                type="button"
                className="video-agent-composer-context"
                onClick={(event) => onOpenSources(event.currentTarget)}
                aria-expanded={sourcesExpanded}
                aria-controls="video-agent-sources-panel"
                aria-label={`当前参考${sourceLabel}，共${activeSourceCount}条视频`}
              >
                <FolderOpen size={16} aria-hidden="true" />
                <span>{sourceLabel}</span>
                <b>{activeSourceCount}</b>
              </button>
              <div ref={optionsPickerRef} className="video-agent-options-picker">
                <button
                  ref={optionsTriggerRef}
                  type="button"
                  className="video-agent-options-trigger"
                  disabled={sending || backgroundActive}
                  onClick={() => optionsOpen ? closeOptions() : openOptions()}
                  aria-haspopup="dialog"
                  aria-expanded={optionsOpen}
                  aria-controls="video-agent-options-menu"
                  aria-label={`调整回答方式：${researchLabel}，${outputLabel}，${webLabel}`}
                >
                  <SlidersHorizontal size={16} aria-hidden="true" />
                  <span>回答方式</span>
                  <CaretDown size={11} aria-hidden="true" />
                </button>
                <div id="video-agent-options-menu">
                  <AgentOptionsSheet
                    open={optionsOpen}
                    researchMode={draftResearchMode}
                    outputStyle={draftOutputStyle}
                    webScope={draftWebScope}
                    disabled={sending || backgroundActive}
                    onResearchModeChange={setDraftResearchMode}
                    onOutputStyleChange={setDraftOutputStyle}
                    onWebScopeChange={setDraftWebScope}
                  />
                </div>
              </div>
            </div>

            {question.length >= 480 && (
              <span className="video-agent-composer-count" aria-live="polite">
                {question.length}/600
              </span>
            )}

            {sending ? (
              <button
                type="button"
                className="video-agent-send is-stop"
                onClick={onStop}
                aria-label="停止等待，后台继续处理"
                title="停止等待，后台继续处理"
              >
                <Stop size={16} weight="fill" />
                <span>停止</span>
              </button>
            ) : (
              <button
                type="submit"
                className="video-agent-send"
                disabled={!question.trim() || modelSaving || backgroundActive}
                aria-label="发送问题"
              >
                <PaperPlaneTilt size={17} weight="fill" />
              </button>
            )}
          </div>
        </form>
        </footer>
      </>
    );
  },
));

AgentComposer.displayName = 'AgentComposer';

export default AgentComposer;
