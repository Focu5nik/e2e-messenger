import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, TypeAlias

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import AuthSession, Device, User
from app.auth.security import AccessTokenError, decode_access_token
from app.config import get_settings
from app.database import get_session

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True, slots=True)
class Principal:
    user_id: uuid.UUID
    device_id: uuid.UUID
    session_id: uuid.UUID


def unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid or expired authentication",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _is_expired(value: datetime) -> bool:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value <= datetime.now(UTC)

 
async def get_principal(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Principal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise unauthorized()
    try:
        claims = decode_access_token(credentials.credentials, get_settings())
    except AccessTokenError as exc:
        raise unauthorized() from exc

    row = (
        await session.execute(
            select(User, Device, AuthSession)
            .select_from(AuthSession)
            .join(Device, Device.id == AuthSession.device_id)
            .join(User, User.id == Device.user_id)
            .where(AuthSession.id == claims.session_id)
        )
    ).one_or_none()
    if row is None:
        raise unauthorized()
    user, device, auth_session = row
    if (
        user.id != claims.user_id
        or device.id != claims.device_id
        or device.user_id != claims.user_id
        or auth_session.device_id != claims.device_id
        or user.status != "active"
        or device.revoked_at is not None
        or auth_session.revoked_at is not None
        or not auth_session.refresh_cookie_bound
        or _is_expired(auth_session.refresh_expires_at)
    ):
        raise unauthorized()
    return Principal(
        user_id=claims.user_id,
        device_id=claims.device_id,
        session_id=claims.session_id,
    )


CurrentPrincipal: TypeAlias = Annotated[Principal, Depends(get_principal)]
