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
  CaretDown,
  Check,
  FolderOpen,
  Gift,
  ListChecks,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  SlidersHorizontal,
} from '@phosphor-icons/react';
import AIModelIcon from '@/components/AIModelIcon';
import AgentModelConfigSheet, {
  type ModelConfigDraft,
  type ModelConfigSaveResult,
} from '@/components/agent/AgentModelConfigSheet';
import AgentOptionsSheet from '@/components/agent/AgentOptionsSheet';
import { useRouter } from 'next/navigation';
import type { UserAIProviderConfig, UserChatModel } from '@/lib/api';
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
  contextTitle?: string;
  contextType?: 'video' | 'plan';
  accountPoints: number;
  aiProviderConfig: UserAIProviderConfig | null;
  availableModels: UserChatModel[];
  backgroundActive: boolean;
  customInstruction: string;
  modelCatalogLoading: boolean;
  modelError: string;
  modelSaving: boolean;
  modelConfigSaving: boolean;
  outputLabel: string;
  outputStyle: LibraryOutputStyle;
  queuedCount: number;
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
  onConfigureCustomModel: (value: ModelConfigDraft, action: 'save' | 'test' | 'reset') => Promise<ModelConfigSaveResult | null>;
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
  code?: string;
  modelId?: string;
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

function getModelGroupId(option: ComposerModelOption): typeof MODEL_GROUPS[number]['id'] {
  return option.id === '__custom__' || option.id.startsWith('custom:') ? 'custom' : 'platform';
}

const AgentComposer = memo(forwardRef<AgentComposerHandle, AgentComposerProps>(
  function AgentComposer({
    activeSourceCount,
    contextTitle,
    contextType = 'video',
    accountPoints,
    aiProviderConfig,
    availableModels,
    backgroundActive,
    customInstruction,
    modelCatalogLoading,
    modelError,
    modelSaving,
    modelConfigSaving,
    outputLabel,
    outputStyle,
    queuedCount,
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
    onConfigureCustomModel,
    onApplyOptions,
    onStop,
    onSubmitQuestion,
  }, ref) {
    const isMobile = useIsMobile();
    const router = useRouter();
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const modelPickerRef = useRef<HTMLDivElement | null>(null);
    const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
    const optionsPickerRef = useRef<HTMLDivElement | null>(null);
    const optionsTriggerRef = useRef<HTMLButtonElement | null>(null);
    const [question, setQuestion] = useState('');
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [modelMenuPosition, setModelMenuPosition] = useState<ModelMenuPosition | null>(null);
    const [modelQuery, setModelQuery] = useState('');
    const [modelConfigOpen, setModelConfigOpen] = useState(false);
    const [modelConfigBusy, setModelConfigBusy] = useState<'' | 'save' | 'test' | 'reset'>('');
    const [modelConfigDraft, setModelConfigDraft] = useState<ModelConfigDraft>({
      providerName: 'OpenAI Compatible',
      model: '',
      apiBase: '',
      apiKey: '',
    });
    const [modelConfigFeedback, setModelConfigFeedback] = useState<{
      error: string;
      success: string;
    }>({ error: '', success: '' });
    const [optionsOpen, setOptionsOpen] = useState(false);
    const [draftResearchMode, setDraftResearchMode] = useState(researchMode);
    const [draftOutputStyle, setDraftOutputStyle] = useState(outputStyle);
    const [draftWebScope, setDraftWebScope] = useState(webScope);

    const modelOptions = useMemo<ComposerModelOption[]>(() => {
      const options: ComposerModelOption[] = [];
      availableModels.forEach((item) => options.push({
        id: item.id,
        modelId: item.icon_key,
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
      (aiProviderConfig?.custom_models ?? []).forEach((item) => {
        options.push({
          id: `custom:${item.id}`,
          code: `custom:${item.id}`,
          modelId: item.model,
          name: item.name || item.provider_name,
          provider: item.provider_name || '自带供应商',
          free: false,
          points: 0,
          detail: item.enabled ? '使用你的 API Key' : '已停用',
        });
      });
      return options;
    }, [aiProviderConfig, availableModels]);

    const selectedModelOption = modelOptions.find((option) => option.id === selectedModel)
      || modelOptions[0]
      || { id: '', name: '暂无可用模型', provider: '知萃平台', free: false, points: 0, detail: '' };
    const filteredModelOptions = useMemo(() => {
      const query = modelQuery.trim().toLocaleLowerCase('zh-CN');
      if (!query) return modelOptions;
      return modelOptions.filter((option) => (
        `${option.name} ${option.provider} ${option.modelId || ''}`.toLocaleLowerCase('zh-CN').includes(query)
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

    const openModelConfig = () => {
      setModelMenuOpen(false);
      setModelQuery('');
      const customConfig = aiProviderConfig?.mode === 'custom' ? aiProviderConfig : null;
      setModelConfigDraft({
        providerName: customConfig?.provider_name || 'OpenAI Compatible',
        model: customConfig?.model || '',
        apiBase: customConfig?.api_base || '',
        apiKey: '',
      });
      setModelConfigFeedback({ error: '', success: '' });
      setModelConfigOpen(true);
    };

    const goToModelSettings = () => {
      setModelMenuOpen(false);
      setModelQuery('');
      router.push('/settings?section=models');
    };

    const closeModelConfig = () => {
      setModelConfigOpen(false);
      setModelConfigBusy('');
      setModelConfigFeedback({ error: '', success: '' });
      modelTriggerRef.current?.focus();
    };

    const patchModelConfig = (patch: Partial<ModelConfigDraft>) => {
      setModelConfigDraft((current) => ({ ...current, ...patch }));
    };

    const runModelConfigAction = async (action: 'save' | 'test' | 'reset') => {
      if (modelConfigBusy) return;
      setModelConfigBusy(action);
      setModelConfigFeedback({ error: '', success: '' });
      const result = await onConfigureCustomModel(modelConfigDraft, action);
      setModelConfigBusy('');
      if (result) {
        setModelConfigFeedback(
          result.kind === 'tested'
            ? { error: '', success: result.label }
            : { error: '', success: result.label },
        );
      }
      if (result?.kind === 'saved' || result?.kind === 'reset') {
        setModelConfigOpen(false);
      }
    };

    useEffect(() => {
      if (!modelConfigOpen) return;
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          closeModelConfig();
        }
      };
      document.addEventListener('keydown', closeOnEscape);
      return () => {
        document.removeEventListener('keydown', closeOnEscape);
      };
    }, [modelConfigOpen]);

    useImperativeHandle(ref, () => ({
      clear: () => setQuestion(''),
      focus: () => textareaRef.current?.focus(),
      getValue: () => question,
      setValue: (value: string) => setQuestion(value),
    }), [question]);

    const submit = (event: FormEvent) => {
      event.preventDefault();
      const content = question.trim();
      if (!content || modelSaving) return;
      onSubmitQuestion(content);
    };

    const openOptions = () => {
      setModelConfigOpen(false);
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
              title={isMobile ? '选择回答模型' : '选择本次对话使用的模型'}
            >
              <button
                ref={modelTriggerRef}
                type="button"
                className="video-agent-model-trigger"
                aria-label="选择回答模型"
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
                  <AIModelIcon code={selectedModelOption.code || selectedModelOption.id} modelId={selectedModelOption.modelId} name={selectedModelOption.name} provider={selectedModelOption.provider} size={16} />
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
                    <strong>选择模型</strong>
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
                              onClick={() => (
                                option.id === '__custom__' ? openModelConfig() : chooseModel(option.id)
                              )}
                            >
                              <span className="video-agent-model-glyph" aria-hidden="true">
                                <AIModelIcon code={option.code || option.id} modelId={option.modelId} name={option.name} provider={option.provider} size={18} />
                              </span>
                              <span>
                                <strong>{option.name}</strong>
                                <small>{isMobile && option.id === '__custom__' ? '点按编辑连接' : option.id === '__custom__' ? '点按编辑连接' : option.detail}</small>
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
                  <button
                    type="button"
                    className="video-agent-model-config-link"
                    onClick={goToModelSettings}
                  >
                    <Plus size={15} weight="bold" aria-hidden="true" />
                    <span>配置自定义模型</span>
                    {(aiProviderConfig?.custom_models?.length ?? 0) > 0 && <em>已接入 {(aiProviderConfig?.custom_models ?? []).length} 个</em>}
                  </button>
                </section>
              )}
            </div>
            <span className="sr-only" role="status" aria-live="polite">
              {statusMessage}
            </span>
          </div>

          {modelError && !modelConfigOpen && (
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
                && !modelSaving
                && question.trim()
              ) {
                event.preventDefault();
                onSubmitQuestion(question.trim());
              }
            }}
            placeholder={
              sending || backgroundActive
                ? '可以先写下一问，当前回答完成后再发送'
                : contextType === 'plan'
                  ? '例如：把下周安排得轻一点，只保留最重要的三步…'
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
              {contextType === 'plan' ? (
                <span
                  className="video-agent-composer-context is-plan"
                  aria-label={`当前计划：${contextTitle || '行动计划'}`}
                >
                  <ListChecks size={16} aria-hidden="true" />
                  <span>{contextTitle || '当前计划'}</span>
                </span>
              ) : (
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
              )}
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

            {queuedCount > 0 && (
              <span className="video-agent-composer-queue-count">
                {queuedCount} 条待发送
              </span>
            )}

            <div className="video-agent-composer-send-actions">
              {(!sending || question.trim()) && (
                <button
                  type="submit"
                  className="video-agent-send"
                  disabled={!question.trim() || modelSaving}
                  aria-label={sending || backgroundActive ? '排队发送下一问' : '发送问题'}
                  title={sending || backgroundActive ? '当前回答完成后自动发送' : '发送问题'}
                >
                  <PaperPlaneTilt size={17} weight="fill" />
                </button>
              )}
              {sending && (
                <button
                  type="button"
                  className="video-agent-send is-stop"
                  onClick={onStop}
                  aria-label="停止生成"
                  title="停止生成"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                    <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </form>
        </footer>

        <AgentModelConfigSheet
          open={modelConfigOpen}
          busy={modelConfigBusy}
          apiKeySet={aiProviderConfig?.api_key_set || false}
          apiKeyMasked={aiProviderConfig?.api_key_masked || ''}
          draft={modelConfigDraft}
          disabled={modelConfigSaving}
          error={modelConfigFeedback.error || (modelConfigOpen ? modelError : '')}
          success={modelConfigFeedback.success}
          onDraftChange={patchModelConfig}
          onSave={() => void runModelConfigAction('save')}
          onTest={() => void runModelConfigAction('test')}
          onReset={() => void runModelConfigAction('reset')}
          onClose={closeModelConfig}
        />
      </>
    );
  },
));

AgentComposer.displayName = 'AgentComposer';

export default AgentComposer;
