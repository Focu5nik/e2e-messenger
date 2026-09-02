import asyncio
import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.auth.models import AuthSession, Device, RefreshTokenHistory, User
from app.auth.security import generate_refresh_token, hash_refresh_token
from app.auth.service import AuthService, IssuedTokens, RefreshTokenReuseError
from app.config import Settings

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")


@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="TEST_DATABASE_URL is required for PostgreSQL locking verification",
)
@pytest.mark.asyncio
async def test_same_refresh_token_race_rotates_once_then_revokes_family() -> None:
    assert TEST_DATABASE_URL is not None
    engine = create_async_engine(TEST_DATABASE_URL)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    settings = Settings(
        database_url=TEST_DATABASE_URL,
        jwt_secret="test-only-secret-that-is-at-least-32-characters",
        _env_file=None,
    )
    service = AuthService(settings)
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    auth_session_id = uuid.uuid4()
    refresh_token = generate_refresh_token()
    now = datetime.now(UTC)
    application_name = f"refresh-race-{auth_session_id}"

    try:
        async with session_factory() as session:
            session.add_all(
                [
                    User(
                        id=user_id,
                        username=f"race-{user_id}",
                        password_hash="not-used-in-this-test",
                    ),
                    Device(
                        id=device_id,
                        user_id=user_id,
                        name="Race test",
                        last_seen_at=now,
                    ),
                    AuthSession(
                        id=auth_session_id,
                        device_id=device_id,
                        refresh_token_hash=hash_refresh_token(refresh_token),
                        last_used_at=now,
                        refresh_expires_at=now + timedelta(days=1),
                    ),
                ]
            )
            await session.commit()

        async def refresh_once() -> IssuedTokens:
            async with session_factory() as session:
                await session.execute(
                    select(func.set_config("application_name", application_name, False))
                )
                return await service.refresh(session, refresh_token)

        async with session_factory() as blocking_session:
            await blocking_session.execute(
                select(AuthSession)
                .where(AuthSession.id == auth_session_id)
                .with_for_update()
            )
            refresh_tasks = [
                asyncio.create_task(refresh_once()),
                asyncio.create_task(refresh_once()),
            ]

            lock_wait_error: BaseException | None = None
            try:
                async with session_factory() as observer_session:
                    async with asyncio.timeout(5):
                        while True:
                            await observer_session.execute(
                                select(func.pg_stat_clear_snapshot())
                            )
                            waiting = await observer_session.scalar(
                                text(
                                    """
                                    SELECT count(*)
                                    FROM pg_stat_activity
                                    WHERE application_name = :application_name
                                      AND state = 'active'
                                      AND query ILIKE '%auth_sessions%'
                                    """
                                ),
                                {"application_name": application_name},
                            )
                            if waiting == 2:
                                break
                            await asyncio.sleep(0.01)
            except BaseException as exc:
                lock_wait_error = exc
            finally:
                await blocking_session.commit()

            if lock_wait_error is not None:
                await asyncio.gather(*refresh_tasks, return_exceptions=True)
                raise lock_wait_error

        results = await asyncio.gather(*refresh_tasks, return_exceptions=True)

        assert sum(isinstance(result, IssuedTokens) for result in results) == 1
        assert sum(
            isinstance(result, RefreshTokenReuseError) for result in results
        ) == 1

        async with session_factory() as session:
            auth_session = await session.get(AuthSession, auth_session_id)
            history = (
                await session.scalars(
                    select(RefreshTokenHistory).where(
                        RefreshTokenHistory.auth_session_id == auth_session_id
                    )
                )
            ).all()
            assert auth_session is not None
            assert auth_session.revoked_at is not None
            assert [item.token_hash for item in history] == [
                hash_refresh_token(refresh_token)
            ]
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()
