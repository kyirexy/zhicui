export interface WebBuildManifest {
  schema_version: 1;
  build_id: string;
  revision: string;
  version: string;
  built_at: string;
}

const BUILD_ID_PATTERN = /^[0-9A-Za-z._-]{8,160}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWebBuildManifest(value: unknown): WebBuildManifest {
  if (!isRecord(value)) throw new Error('网页版本标识不是有效对象');
  const valid = value.schema_version === 1
    && typeof value.build_id === 'string'
    && BUILD_ID_PATTERN.test(value.build_id)
    && typeof value.revision === 'string'
    && value.revision.length >= 4
    && value.revision.length <= 80
    && typeof value.version === 'string'
    && VERSION_PATTERN.test(value.version)
    && typeof value.built_at === 'string'
    && Number.isFinite(Date.parse(value.built_at));
  if (!valid) throw new Error('网页版本标识格式无效');
  return {
    schema_version: 1,
    build_id: value.build_id as string,
    revision: value.revision as string,
    version: value.version as string,
    built_at: value.built_at as string,
  };
}

export function isDifferentWebBuild(
  current: WebBuildManifest,
  latest: WebBuildManifest,
): boolean {
  return current.build_id !== latest.build_id;
}
