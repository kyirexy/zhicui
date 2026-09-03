import { CliError } from './errors.js';
import type { AgentActionDefinition, AgentCapabilities } from './types.js';

export const USER_COMMAND_DOMAINS = [
  'auth',
  'library',
  'creator',
  'ask',
  'knowledge',
  'plan',
  'automation',
  'analysis',
  'models',
  'feedback',
  'account',
  'local',
  'run',
  'mcp',
  'agent',
] as const;

export interface DomainAlias {
  candidates: string[];
  positionalKeys?: string[];
  /**
   * Schema fields intentionally supplied through named --flags or stdin JSON.
   * Keep this explicit so aliases with structured inputs do not silently look
   * complete while omitting required Action fields.
   */
  namedInputKeys?: string[];
}

const aliases: Record<string, DomainAlias> = {
  'library.list': { candidates: ['library.list', 'library.notes.list', 'library.sources.list'] },
  'library.get': { candidates: ['library.get', 'library.note.get', 'library.source.get'], positionalKeys: ['note_id'] },
  'library.import': { candidates: ['library.import_link', 'library.link.import'], positionalKeys: ['url'] },
  'library.sync': { candidates: ['library.sync.start', 'library.sync', 'library.sources.sync'], positionalKeys: ['mode'] },
  'library.transcript': { candidates: ['library.transcript.generate', 'library.transcript.get', 'library.source.transcript'], positionalKeys: ['aweme_id'] },
  'library.transcribe': { candidates: ['library.transcript.batch', 'library.transcript.prepare', 'library.source.transcribe'], namedInputKeys: ['aweme_ids'] },
  'library.delete': { candidates: ['library.remove', 'library.delete', 'library.source.delete'], positionalKeys: ['note_id'] },
  'creator.list': { candidates: ['creator.list', 'creator.sources.list'] },
  'creator.resolve': { candidates: ['creator.resolve', 'creator.profile.resolve'], positionalKeys: ['platform', 'profile_ref'] },
  'creator.get': { candidates: ['creator.get', 'creator.profile.get'], positionalKeys: ['source_id'] },
  'creator.works': { candidates: ['creator.items.list', 'creator.works.list', 'creator.videos.list'], positionalKeys: ['source_id'] },
  'creator.sync': { candidates: ['creator.sync.start', 'creator.sync', 'creator.works.sync'], positionalKeys: ['source_id'] },
  'ask.start': { candidates: ['ask.turn.start', 'ask.start', 'ask.turn.create', 'conversation.turn.create'], positionalKeys: ['thread_id', 'client_turn_id', 'question'] },
  'ask.get': { candidates: ['ask.thread.get', 'ask.get', 'ask.turn.get', 'conversation.turn.get'], positionalKeys: ['thread_id'] },
  'ask.cancel': { candidates: ['ask.turn.cancel', 'ask.cancel', 'conversation.turn.cancel'], positionalKeys: ['thread_id', 'turn_id'] },
  'ask.retry': { candidates: ['ask.turn.retry', 'ask.retry', 'conversation.turn.retry'], positionalKeys: ['thread_id', 'turn_id'] },
  'ask.conversations': { candidates: ['ask.thread.list', 'ask.conversations.list', 'conversation.list'] },
  'knowledge.list': { candidates: ['knowledge.list', 'knowledge.cards.list'] },
  'knowledge.get': { candidates: ['knowledge.get', 'knowledge.card.get'], positionalKeys: ['entry_id'] },
  'knowledge.create': { candidates: ['knowledge.create', 'knowledge.card.create'], positionalKeys: ['title', 'content'] },
  'knowledge.update': { candidates: ['knowledge.update', 'knowledge.card.update'], positionalKeys: ['entry_id'] },
  'knowledge.delete': { candidates: ['knowledge.remove', 'knowledge.delete', 'knowledge.card.delete'], positionalKeys: ['entry_id'] },
  'plan.list': { candidates: ['plan.list', 'plans.list'] },
  'plan.get': { candidates: ['plan.get', 'plans.get'], positionalKeys: ['plan_id'] },
  'plan.create': { candidates: ['plan.create', 'plans.create'], positionalKeys: ['title'] },
  'plan.update': { candidates: ['plan.update', 'plans.update'], positionalKeys: ['plan_id'] },
  'plan.delete': { candidates: ['plan.remove', 'plan.delete', 'plans.delete'], positionalKeys: ['plan_id'] },
  'plan.adjust': { candidates: ['plan.coach.preview', 'plan.adjust', 'plans.ai_adjust'], positionalKeys: ['plan_id', 'instruction'] },
  'plan.task-add': { candidates: ['plan.task.add', 'plans.task.add'], positionalKeys: ['plan_id', 'title'] },
  'plan.task-update': { candidates: ['plan.task.update', 'plans.task.update'], positionalKeys: ['plan_id', 'task_id'] },
  'plan.task-delete': { candidates: ['plan.task.remove', 'plan.task.delete', 'plans.task.delete'], positionalKeys: ['plan_id', 'task_id'] },
  'automation.list': { candidates: ['automation.list', 'automations.list'] },
  'automation.get': { candidates: ['automation.get', 'automations.get'], positionalKeys: ['automation_id'] },
  'automation.create': { candidates: ['automation.create', 'automations.create'] },
  'automation.update': { candidates: ['automation.update', 'automations.update'], positionalKeys: ['automation_id'] },
  'automation.delete': { candidates: ['automation.remove', 'automation.delete', 'automations.delete'], positionalKeys: ['automation_id'] },
  'automation.run': { candidates: ['automation.run', 'automations.run'], positionalKeys: ['automation_id'] },
  'analysis.prepare': { candidates: ['analysis.run.prepare', 'analysis.prepare', 'video.analysis.prepare'], namedInputKeys: ['note_ids'] },
  'analysis.confirm': { candidates: ['analysis.run.confirm', 'analysis.confirm', 'video.analysis.confirm'], positionalKeys: ['run_id'] },
  'analysis.get': { candidates: ['analysis.run.get', 'analysis.get', 'video.analysis.get'], positionalKeys: ['run_id'] },
  'analysis.cancel': { candidates: ['analysis.run.cancel', 'analysis.cancel', 'video.analysis.cancel'], positionalKeys: ['run_id'] },
  'models.list': { candidates: ['models.list', 'model.catalog.list'] },
  'models.get': { candidates: ['models.settings.get', 'models.get', 'model.selection.get'] },
  'models.select': { candidates: ['models.selection.set', 'models.select', 'model.selection.update'], positionalKeys: ['kind'], namedInputKeys: ['offering_id', 'model_id'] },
  'models.byok-status': { candidates: ['models.custom.list', 'models.byok.status', 'model.byok.status'] },
  'models.byok-update': { candidates: ['models.secret.update', 'models.byok.update', 'model.byok.update'], namedInputKeys: ['target', 'model_id'] },
  'models.custom-create': { candidates: ['models.custom.create'], namedInputKeys: ['name', 'provider_name', 'model', 'api_base'] },
  'models.secret-update': { candidates: ['models.secret.update'], namedInputKeys: ['target', 'model_id'] },
  'feedback.create': { candidates: ['feedback.submit', 'feedback.create'], positionalKeys: ['category', 'subject', 'content'] },
  'feedback.list': { candidates: ['feedback.list', 'feedback.mine'] },
  'account.get': { candidates: ['account.me', 'account.get', 'account.profile.get'] },
  'account.export': { candidates: ['account.data.export', 'account.export'] },
  'account.delete': { candidates: ['account.delete', 'account.close'] },
  'local.status': { candidates: ['local.status', 'local.capabilities.get'] },
  'local.platform-login': { candidates: ['local.platform.login'], positionalKeys: ['platform'] },
  'local.platform-status': { candidates: ['local.platform.status'], positionalKeys: ['platform'] },
  'local.platform-sync': { candidates: ['local.platform.sync', 'local.platform.collect'], positionalKeys: ['platform', 'mode', 'limit'] },
  'local.platform-cancel': { candidates: ['local.platform.cancel'] },
  'local.platform-disconnect': { candidates: ['local.platform.disconnect', 'local.platform.logout'], positionalKeys: ['platform'] },
  'local.platform-rebind': { candidates: ['local.platform.rebind'], positionalKeys: ['platform'] },
  'local.media-settings': { candidates: ['local.media.settings.get'] },
  'local.media-directory': { candidates: ['local.media.directory.choose'] },
  'local.media-open': { candidates: ['local.media.open'], positionalKeys: ['aweme_id'] },
  'local.media-delete': { candidates: ['local.media.delete'], positionalKeys: ['aweme_id'] },
  'local.update-check': { candidates: ['local.update.check', 'local.client.update.check'] },
  'local.update-install': { candidates: ['local.update.install', 'local.client.update.install'] },
};

function normalized(value: string): string {
  return value.toLowerCase().replace(/[_/:-]+/gu, '.').replace(/\.+/gu, '.');
}

export function aliasFor(domain: string, verb: string): DomainAlias {
  return aliases[`${domain}.${verb}`] || {
    candidates: [`${domain}.${verb.replace(/-/gu, '.')}`],
  };
}

/** Stable contract surface used by release tests and generated help. */
export function domainAliasEntries(): ReadonlyArray<readonly [string, DomainAlias]> {
  return Object.entries(aliases).map(([command, alias]) => [command, {
    candidates: [...alias.candidates],
    ...(alias.positionalKeys ? { positionalKeys: [...alias.positionalKeys] } : {}),
    ...(alias.namedInputKeys ? { namedInputKeys: [...alias.namedInputKeys] } : {}),
  }] as const);
}

export function resolveDomainAction(
  capabilities: AgentCapabilities,
  domain: string,
  verb: string,
): { action: AgentActionDefinition; alias: DomainAlias } {
  const alias = aliasFor(domain, verb);
  const actions = capabilities.actions;
  let action = alias.candidates
    .map((candidate) => actions.find((item) => normalized(item.id) === normalized(candidate)))
    .find(Boolean);
  if (!action) {
    const commandAlias = normalized(`${domain}.${verb}`);
    action = actions.find((item) =>
      item.aliases?.some((value) => normalized(value) === commandAlias),
    );
  }
  if (!action) {
    const suffix = normalized(verb);
    const candidates = actions.filter((item) => {
      const id = normalized(item.id);
      return id.startsWith(`${normalized(domain)}.`) && id.endsWith(`.${suffix}`);
    });
    if (candidates.length === 1) action = candidates[0];
  }
  if (!action) {
    throw new CliError(
      'ACTION_NOT_AVAILABLE',
      `当前服务未提供 ${domain} ${verb} 对应的普通用户 Action`,
    );
  }
  if (!action.available) {
    if (action.execution_location === 'local_windows') return { action, alias };
    throw new CliError(
      'ACTION_NOT_AVAILABLE',
      action.unavailable_reason || `${action.title} 当前未开放`,
    );
  }
  return { action, alias };
}

export function domainHelp(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const domain of USER_COMMAND_DOMAINS) result[domain] = [];
  for (const key of Object.keys(aliases)) {
    const [domain, ...parts] = key.split('.');
    result[domain]?.push(parts.join('.'));
  }
  return result;
}
