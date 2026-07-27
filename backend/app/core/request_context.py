"""Request-scoped attribution for nested services such as the LLM agent chain."""

from contextvars import ContextVar, Token


_current_user_id: ContextVar[str | None] = ContextVar(
    "current_user_id",
    default=None,
)
_current_request_path: ContextVar[str | None] = ContextVar(
    "current_request_path",
    default=None,
)


def set_request_context(
    user_id: str | None,
    request_path: str | None,
) -> tuple[Token, Token]:
    return (
        _current_user_id.set(user_id),
        _current_request_path.set(request_path),
    )


def reset_request_context(tokens: tuple[Token, Token]) -> None:
    _current_user_id.reset(tokens[0])
    _current_request_path.reset(tokens[1])


def get_current_user_id() -> str | None:
    return _current_user_id.get()


def get_current_request_path() -> str | None:
    return _current_request_path.get()
