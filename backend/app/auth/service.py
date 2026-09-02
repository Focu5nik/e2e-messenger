import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from anyio import to_thread
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth.dependencies import Principal, _is_expired
from app.auth.models import AuthSession, Device, RefreshTokenHistory, User
from app.auth.schemas import (
    DeviceResponse,
    LoginRequest,
    MeResponse,
    RegisterRequest,
    TokenResponse,
)
from app.auth.security import (
    PASSWORD_HASH,
    create_access_token,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    verify_password,
)
from app.config import Settings

# A valid hash keeps nonexistent-user verification on the same expensive code path.
_DUMMY_PASSWORD_HASH = PASSWORD_HASH.hash("not-a-real-user-password")


class InvalidCredentialsError(Exception):
    pass


class RefreshTokenReuseError(InvalidCredentialsError):
    pass


class ForbiddenError(Exception):
    pass


class ConflictError(Exception):
    pass


class NotFoundError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class IssuedTokens:
    response: TokenResponse
    refresh_token: str
    refresh_expires_at: datetime


class AuthService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def register(
        self, session: AsyncSession, request: RegisterRequest
    ) -> User:
        user = User(
            username=request.username,
            password_hash=await to_thread.run_sync(hash_password, request.password),
        )
        session.add(user)
        try:
            await session.commit()
        except IntegrityError as exc:
            await session.rollback()
            raise ConflictError("username is already registered") from exc
        await session.refresh(user)
        return user

    async def login(
        self, session: AsyncSession, request: LoginRequest
    ) -> IssuedTokens:
        user = (
            await session.execute(select(User).where(User.username == request.username))
        ).scalar_one_or_none()
        candidate_hash = user.password_hash if user is not None else _DUMMY_PASSWORD_HASH
        password_matches = await to_thread.run_sync(
            verify_password, request.password, candidate_hash
        )
        if user is None or not password_matches:
            raise InvalidCredentialsError
        if user.status != "active":
            raise ForbiddenError("account is not active")

        device = await session.get(Device, request.device_id)
        now = datetime.now(UTC)
        if device is None:
            device = Device(
                id=request.device_id,
                user_id=user.id,
                name=request.device_name,
                last_seen_at=now,
            )
            session.add(device)
        elif device.user_id != user.id:
            raise ConflictError("device identifier is already registered")
        elif device.revoked_at is not None:
            raise ForbiddenError("device is revoked")
        else:
            device.name = request.device_name
            device.last_seen_at = now

        token = generate_refresh_token()
        auth_session = AuthSession(
            device_id=device.id,
            refresh_token_hash=hash_refresh_token(token),
            refresh_cookie_bound=True,
            last_used_at=now,
            refresh_expires_at=now
            + timedelta(days=self.settings.refresh_token_ttl_days),
        )
        session.add(auth_session)
        try:
            await session.commit()
        except IntegrityError as exc:
            await session.rollback()
            raise ConflictError("device identifier is already registered") from exc

        return self._tokens(
            user.id,
            device.id,
            auth_session.id,
            token,
            auth_session.refresh_expires_at,
        )

    async def refresh(
        self, session: AsyncSession, refresh_token: str
    ) -> IssuedTokens:
        refresh_token_hash = hash_refresh_token(refresh_token)
        auth_session = (
            await session.execute(
                select(AuthSession)
                .options(
                    selectinload(AuthSession.device).selectinload(Device.user)
                )
                .where(
                    AuthSession.refresh_token_hash == refresh_token_hash
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        # PostgreSQL may wait here for another rotation of the same token. Recheck
        # the mutable predicate after acquiring the row lock so only one caller
        # can rotate and every loser follows the consumed-token reuse path.
        if (
            auth_session is not None
            and auth_session.refresh_token_hash != refresh_token_hash
        ):
            auth_session = None
        if auth_session is None:
            reused_session = (
                await session.execute(
                    select(AuthSession)
                    .join(
                        RefreshTokenHistory,
                        RefreshTokenHistory.auth_session_id == AuthSession.id,
                    )
                    .where(RefreshTokenHistory.token_hash == refresh_token_hash)
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if reused_session is not None:
                if reused_session.revoked_at is None:
                    reused_session.revoked_at = datetime.now(UTC)
                await session.commit()
                raise RefreshTokenReuseError
            raise InvalidCredentialsError

        device = auth_session.device
        if device is None:
            raise InvalidCredentialsError
        user = device.user
        if (
            user is None
            or user.status != "active"
            or device.revoked_at is not None
            or auth_session.revoked_at is not None
            or not auth_session.refresh_cookie_bound
            or _is_expired(auth_session.refresh_expires_at)
        ):
            raise InvalidCredentialsError

        now = datetime.now(UTC)
        rotated_token = generate_refresh_token()
        session.add(
            RefreshTokenHistory(
                token_hash=refresh_token_hash,
                auth_session_id=auth_session.id,
                consumed_at=now,
            )
        )
        auth_session.refresh_token_hash = hash_refresh_token(rotated_token)
        auth_session.last_used_at = now
        device.last_seen_at = now
        await session.commit()
        return self._tokens(
            user.id,
            device.id,
            auth_session.id,
            rotated_token,
            auth_session.refresh_expires_at,
        )

    async def logout(self, session: AsyncSession, refresh_token: str) -> None:
        refresh_token_hash = hash_refresh_token(refresh_token)
        auth_session = (
            await session.execute(
                select(AuthSession)
                .where(AuthSession.refresh_token_hash == refresh_token_hash)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if auth_session is None:
            auth_session = (
                await session.execute(
                    select(AuthSession)
                    .join(
                        RefreshTokenHistory,
                        RefreshTokenHistory.auth_session_id == AuthSession.id,
                    )
                    .where(RefreshTokenHistory.token_hash == refresh_token_hash)
                    .with_for_update()
                )
            ).scalar_one_or_none()
        if auth_session is not None and auth_session.revoked_at is None:
            auth_session.revoked_at = datetime.now(UTC)
        await session.commit()

    async def get_me(
        self, session: AsyncSession, principal: Principal
    ) -> MeResponse:
        user = await session.get(User, principal.user_id)
        if user is None:  # The auth dependency already enforces this invariant.
            raise InvalidCredentialsError
        return MeResponse(
            id=user.id,
            username=user.username,
            status=user.status,
            created_at=user.created_at,
            device_id=principal.device_id,
            session_id=principal.session_id,
        )

    async def list_devices(
        self, session: AsyncSession, principal: Principal
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

    async def revoke_device(
        self, session: AsyncSession, principal: Principal, device_id: uuid.UUID
    ) -> None:
        device = (
            await session.execute(
                select(Device).where(
                    Device.id == device_id, Device.user_id == principal.user_id
                )
            )
        ).scalar_one_or_none()
        if device is None:
            raise NotFoundError
        if device.revoked_at is None:
            now = datetime.now(UTC)
            device.revoked_at = now
            await session.execute(
                update(AuthSession)
                .where(
                    AuthSession.device_id == device.id,
                    AuthSession.revoked_at.is_(None),
                )
                .values(revoked_at=now)
            )
            await session.commit()

    def _tokens(
        self,
        user_id: uuid.UUID,
        device_id: uuid.UUID,
        session_id: uuid.UUID,
        refresh_token: str,
        refresh_expires_at: datetime,
    ) -> IssuedTokens:
        return IssuedTokens(
            response=TokenResponse(
                access_token=create_access_token(
                    user_id=user_id,
                    device_id=device_id,
                    session_id=session_id,
                    settings=self.settings,
                ),
                expires_in=self.settings.access_token_ttl_minutes * 60,
            ),
            refresh_token=refresh_token,
            refresh_expires_at=refresh_expires_at,
        )
