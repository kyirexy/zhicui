# Douyin private-list source notice

The production sidecar remains the independently deployed
`jiji262/douyin-downloader` pinned by `install.sh`.

The request-shape and SecSDK runner in `private-list-hardening.patch` were
adapted from `juziguai/douyin-mcp-server` commit
`bc3ae50e83eabd0edea25230c0ed719d0f782e59`. That project declares the MIT
license in its `pyproject.toml`. The adapted code is kept inside the isolated
loopback sidecar and is not linked into the FastAPI application.

The ByteDance SecSDK runtime is not stored in this repository. During
deployment it is downloaded from the exact URL declared in
`core/private_list_websign.py`, accepted only when its pinned SHA-256 matches,
and cached with the sidecar runtime files.
