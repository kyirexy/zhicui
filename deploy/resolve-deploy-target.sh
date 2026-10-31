#!/usr/bin/env bash
# 解析明确批准的完整提交；无显式目标时保留既有 master 发布行为。
resolve_deploy_target() {
  local requested="${1:-}" resolved
  if [[ -n "$requested" ]]; then
    [[ "$requested" =~ ^[0-9a-f]{40}$ ]] || {
      printf '直发目标必须为完整的 40 位小写 Git SHA\n' >&2; return 1;
    }
    git fetch --no-tags origin "$requested" >&2 || return 1
    resolved="$(git rev-parse --verify 'FETCH_HEAD^{commit}')" || return 1
    [[ "$resolved" == "$requested" ]] || {
      printf '远端返回的提交与批准目标不一致\n' >&2; return 1;
    }
  else
    git fetch --prune origin master >&2 || return 1
    resolved="$(git rev-parse --verify 'origin/master^{commit}')" || return 1
  fi
  git merge-base --is-ancestor HEAD "$resolved" || {
    printf '目标不是当前 checkout 的快进后继，拒绝发布\n' >&2; return 1;
  }
  printf '%s\n' "$resolved"
}
