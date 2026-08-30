import uuid
from typing import Annotated, TypeAlias

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentPrincipal
from app.auth.models import Device, User
from app.auth.schemas import (
    DeviceResponse,
    LoginRequest,
    MeResponse,
    RefreshRequest,
    RegisterRequest,
    TokenResponse,
    UserResponse,
)
from app.auth.service import (
    AuthService,
    ConflictError,
    ForbiddenError,
    InvalidCredentialsError,
    NotFoundError,
)
from app.config import get_settings
from app.database import get_session

router = APIRouter()
DatabaseSession: TypeAlias = Annotated[AsyncSession, Depends(get_session)]


def auth_service() -> AuthService:
    return AuthService(get_settings())


Service: TypeAlias = Annotated[AuthService, Depends(auth_service)]


@router.post(
    "/auth/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED
)
async def register(
    request: RegisterRequest, session: DatabaseSession, service: Service
) -> User:
    try:
        return await service.register(session, request)
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/auth/login", response_model=TokenResponse)
async def login(
    request: LoginRequest, session: DatabaseSession, service: Service
) -> TokenResponse:
    try:
        return await service.login(session, request)
    except InvalidCredentialsError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid username or password",
        ) from exc
    except ForbiddenError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(
    request: RefreshRequest, session: DatabaseSession, service: Service
) -> TokenResponse:
    try:
        return await service.refresh(session, request.refresh_token)
    except InvalidCredentialsError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or expired refresh token",
        ) from exc


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    principal: CurrentPrincipal, session: DatabaseSession, service: Service
) -> Response:
    await service.logout(session, principal)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=MeResponse)
async def me(principal: CurrentPrincipal, session: DatabaseSession) -> MeResponse:
    user = await session.get(User, principal.user_id)
    if user is None:  # The auth dependency already enforces this invariant.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    return MeResponse(
        id=user.id,
        username=user.username,
        status=user.status,
        created_at=user.created_at,
        device_id=principal.device_id,
        session_id=principal.session_id,
    )


@router.get("/devices", response_model=list[DeviceResponse])
async def devices(
    principal: CurrentPrincipal, session: DatabaseSession
) -> list[DeviceResponse]:
    owned_devices = (
        await session.scalars(
            select(Device)
            .where(Device.user_id == principal.user_id)
            .order_by(Device.created_at, Device.id)
        )
    ).all()
    return [
        DeviceResponse(
            id=device.id,
            name=device.name,
            protocol_version=device.protocol_version,
            created_at=device.created_at,
            last_seen_at=device.last_seen_at,
            revoked_at=device.revoked_at,
            is_current=device.id == principal.device_id,
        )
        for device in owned_devices
    ]


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_device(
    device_id: uuid.UUID,
    principal: CurrentPrincipal,
    session: DatabaseSession,
    service: Service,
) -> Response:
    try:
        await service.revoke_device(session, principal, device_id)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
