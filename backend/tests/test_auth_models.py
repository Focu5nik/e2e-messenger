import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.exc import InvalidRequestError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app.auth.models import AuthSession, Device, User


@pytest.fixture
async def auth_model_ids(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    auth_session_id = uuid.uuid4()
    now = datetime.now(UTC)

    async with session_factory() as session:
        session.add_all(
            [
                User(
                    id=user_id,
                    username="alice",
                    password_hash="not-a-real-password-hash",
                ),
                Device(
                    id=device_id,
                    user_id=user_id,
                    name="Test browser",
                    last_seen_at=now,
                ),
                AuthSession(
                    id=auth_session_id,
                    device_id=device_id,
                    refresh_token_hash="a" * 64,
                    last_used_at=now,
                    refresh_expires_at=now + timedelta(days=1),
                ),
            ]
        )
        await session.commit()

    return user_id, device_id, auth_session_id


@pytest.mark.asyncio
async def test_auth_relationships_reject_implicit_loading(
    session_factory: async_sessionmaker[AsyncSession],
    auth_model_ids: tuple[uuid.UUID, uuid.UUID, uuid.UUID],
) -> None:
    user_id, device_id, auth_session_id = auth_model_ids

    async with session_factory() as session:
        user = await session.get(User, user_id)
        device = await session.get(Device, device_id)
        auth_session = await session.get(AuthSession, auth_session_id)
        assert user is not None
        assert device is not None
        assert auth_session is not None

        for relationship in (
            lambda: user.devices,
            lambda: device.user,
            lambda: device.auth_sessions,
            lambda: auth_session.device,
        ):
            with pytest.raises(InvalidRequestError, match="lazy='raise'"):
                relationship()


@pytest.mark.asyncio
async def test_auth_relationships_allow_explicit_eager_loading(
    session_factory: async_sessionmaker[AsyncSession],
    auth_model_ids: tuple[uuid.UUID, uuid.UUID, uuid.UUID],
) -> None:
    user_id, device_id, auth_session_id = auth_model_ids

    async with session_factory() as session:
        user = (
            await session.scalars(
                select(User)
                .options(
                    selectinload(User.devices)
                    .selectinload(Device.auth_sessions)
                )
                .where(User.id == user_id)
            )
        ).one()
        assert [device.id for device in user.devices] == [device_id]
        assert [item.id for item in user.devices[0].auth_sessions] == [
            auth_session_id
        ]

        auth_session = (
            await session.scalars(
                select(AuthSession)
                .options(
                    selectinload(AuthSession.device).selectinload(Device.user)
                )
                .where(AuthSession.id == auth_session_id)
            )
        ).one()
        assert auth_session.device.id == device_id
        assert auth_session.device.user.id == user_id
