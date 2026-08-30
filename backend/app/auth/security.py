import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from jwt import InvalidTokenError
from pwdlib import PasswordHash

from app.config import Settings

PASSWORD_HASH = PasswordHash.recommended()
JWT_ALGORITHM = "HS256"
JWT_LEEWAY_SECONDS = 30


class AccessTokenError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class AccessTokenClaims:
    user_id: uuid.UUID
    session_id: uuid.UUID
    device_id: uuid.UUID


def hash_password(password: str) -> str:
    return PASSWORD_HASH.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return PASSWORD_HASH.verify(password, password_hash)
    except (TypeError, ValueError):
        return False


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_access_token(
    *, user_id: uuid.UUID, session_id: uuid.UUID, device_id: uuid.UUID, settings: Settings
) -> str:
    issued_at = datetime.now(UTC).replace(microsecond=0)
    expires_at = issued_at + timedelta(minutes=settings.access_token_ttl_minutes)
    payload = {
        "sub": str(user_id),
        "sid": str(session_id),
        "did": str(device_id),
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    return jwt.encode(
        payload, settings.jwt_secret.get_secret_value(), algorithm=JWT_ALGORITHM
    )


def decode_access_token(token: str, settings: Settings) -> AccessTokenClaims:
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.jwt_secret.get_secret_value(),
            algorithms=[JWT_ALGORITHM],
            leeway=JWT_LEEWAY_SECONDS,
            options={
                "require": ["sub", "sid", "did", "iat", "exp"],
                "verify_exp": True,
                "verify_iat": True,
            },
        )
        if type(payload["iat"]) is not int or type(payload["exp"]) is not int:
            raise AccessTokenError("invalid token timestamps")
        if payload["exp"] <= payload["iat"]:
            raise AccessTokenError("invalid token lifetime")
        if any(not isinstance(payload[name], str) for name in ("sub", "sid", "did")):
            raise AccessTokenError("invalid token identifiers")
        return AccessTokenClaims(
            user_id=uuid.UUID(payload["sub"]),
            session_id=uuid.UUID(payload["sid"]),
            device_id=uuid.UUID(payload["did"]),
        )
    except (InvalidTokenError, KeyError, TypeError, ValueError) as exc:
        raise AccessTokenError("invalid access token") from exc
