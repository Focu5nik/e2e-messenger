import uuid
from datetime import UTC, datetime
from math import ceil
from typing import Annotated, TypeAlias

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentPrincipal
from app.auth.models import User
from app.auth.schemas import (
    DeviceResponse,
    LoginRequest,
    MeResponse,
    RegisterRequest,
    TokenResponse,
    UserResponse,
)
from app.auth.service import (
    AuthService,
    ConflictError,
    ForbiddenError,
    IssuedTokens,
    InvalidCredentialsError,
    NotFoundError,
)
from app.config import Settings, get_settings
from app.database import get_session

router = APIRouter()
REFRESH_COOKIE_NAME = "refresh_token"
REFRESH_COOKIE_PATH = "/auth"
REFRESH_TOKEN_MIN_LENGTH = 32
REFRESH_TOKEN_MAX_LENGTH = 512
DatabaseSession: TypeAlias = Annotated[AsyncSession, Depends(get_session)]


def auth_service() -> AuthService:
    return AuthService(get_settings())


Service: TypeAlias = Annotated[AuthService, Depends(auth_service)]


def require_trusted_origin(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    expected_origin = str(settings.frontend_origin).rstrip("/")
    origins = request.headers.getlist("origin")
    if len(origins) != 1 or origins[0] != expected_origin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="invalid request origin",
        )


TrustedOrigin: TypeAlias = Annotated[None, Depends(require_trusted_origin)]


def set_refresh_cookie(response: Response, issued: IssuedTokens) -> None:
    expires_at = issued.refresh_expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=issued.refresh_token,
        max_age=max(0, ceil((expires_at - datetime.now(UTC)).total_seconds())),
        expires=expires_at,
        path=REFRESH_COOKIE_PATH,
        secure=True,
        httponly=True,
        samesite="strict",
    )


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        path=REFRESH_COOKIE_PATH,
        secure=True,
        httponly=True,
        samesite="strict",
    )


def refresh_token_cookie(request: Request) -> str | None:
    token = request.cookies.get(REFRESH_COOKIE_NAME)
    if token is None or not REFRESH_TOKEN_MIN_LENGTH <= len(token) <= REFRESH_TOKEN_MAX_LENGTH:
        return None
    return token


def invalid_refresh_response() -> JSONResponse:
    response = JSONResponse(
        status_code=status.HTTP_401_UNAUTHORIZED,
        content={"detail": "invalid or expired refresh token"},
    )
    clear_refresh_cookie(response)
    return response


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
    request: LoginRequest,
    response: Response,
    session: DatabaseSession,
    service: Service,
    _origin: TrustedOrigin,
) -> TokenResponse:
    try:
        issued = await service.login(session, request)
    except InvalidCredentialsError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid username or password",
        ) from exc
    except ForbiddenError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    set_refresh_cookie(response, issued)
    return issued.response


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(
    request: Request,
    response: Response,
    session: DatabaseSession,
    service: Service,
    _origin: TrustedOrigin,
) -> TokenResponse | Response:
    refresh_token = refresh_token_cookie(request)
    if refresh_token is None:
        return invalid_refresh_response()
    try:
        issued = await service.refresh(session, refresh_token)
    except InvalidCredentialsError:
        return invalid_refresh_response()
    set_refresh_cookie(response, issued)
    return issued.response


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    session: DatabaseSession,
    service: Service,
    _origin: TrustedOrigin,
) -> Response:
    refresh_token = refresh_token_cookie(request)
    if refresh_token is not None:
        await service.logout(session, refresh_token)
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_refresh_cookie(response)
    return response


@router.get("/me", response_model=MeResponse)
async def me(
    principal: CurrentPrincipal, session: DatabaseSession, service: Service
) -> MeResponse:
    try:
        return await service.get_me(session, principal)
    except InvalidCredentialsError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED) from exc


@router.get("/devices", response_model=list[DeviceResponse])
async def devices(
    principal: CurrentPrincipal, session: DatabaseSession, service: Service
) -> list[DeviceResponse]:
    return await service.list_devices(session, principal)


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
