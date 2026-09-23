from typing import Annotated, TypeAlias

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import AuthSession, Device, User
from app.auth.principal import Principal
from app.auth.security import AccessTokenError, decode_access_token
from app.auth.session_policy import is_session_active
from app.config import get_settings
from app.database import get_session

bearer_scheme = HTTPBearer(auto_error=False)


def unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid or expired authentication",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_principal(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Principal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise unauthorized()
    return await authenticate_access_token(credentials.credentials, session)


async def authenticate_access_token(token: str, session: AsyncSession) -> Principal:
    try:
        claims = decode_access_token(token, get_settings())
    except AccessTokenError as exc:
        raise unauthorized() from exc

    row = (
        await session.execute(
            select(User, Device, AuthSession)
            .select_from(AuthSession)
            .join(AuthSession.device)
            .join(Device.user)
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
        or not is_session_active(user, device, auth_session)
    ):
        raise unauthorized()
    return Principal(
        user_id=claims.user_id,
        device_id=claims.device_id,
        session_id=claims.session_id,
    )


CurrentPrincipal: TypeAlias = Annotated[Principal, Depends(get_principal)]
