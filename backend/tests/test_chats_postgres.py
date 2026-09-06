import asyncio
import os
import uuid

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.auth.models import User
from app.chats.models import Chat, ChatMember, DirectChatPair
from app.chats.service import ChatService, DirectChatView


TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")


class SynchronizedChatService(ChatService):
    def __init__(self) -> None:
        self.initial_lookups = 0
        self.both_looked_up = asyncio.Event()

    async def _pair_chat_id(
        self,
        session: AsyncSession,
        user_low_id: uuid.UUID,
        user_high_id: uuid.UUID,
    ) -> uuid.UUID | None:
        chat_id = await super()._pair_chat_id(
            session, user_low_id, user_high_id
        )
        if chat_id is None and self.initial_lookups < 2:
            self.initial_lookups += 1
            if self.initial_lookups == 2:
                self.both_looked_up.set()
            await self.both_looked_up.wait()
        return chat_id


@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="TEST_DATABASE_URL is required for PostgreSQL trigger verification",
)
@pytest.mark.asyncio
async def test_direct_chat_rejects_third_member() -> None:
    assert TEST_DATABASE_URL is not None
    engine = create_async_engine(TEST_DATABASE_URL)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    service = ChatService()
    first_id = uuid.uuid4()
    second_id = uuid.uuid4()
    outsider_id = uuid.uuid4()
    chat_id: uuid.UUID | None = None

    try:
        async with session_factory() as session:
            session.add_all(
                [
                    User(
                        id=user_id,
                        username=f"chat-member-limit-{user_id}",
                        password_hash="not-used",
                    )
                    for user_id in (first_id, second_id, outsider_id)
                ]
            )
            await session.commit()

        async with session_factory() as session:
            view = await service.open_direct_chat(session, first_id, second_id)
            chat_id = view.chat.id

        async with session_factory() as session:
            session.add(ChatMember(chat_id=chat_id, user_id=outsider_id))
            with pytest.raises(IntegrityError):
                await session.commit()
            await session.rollback()

        async with session_factory() as session:
            assert (
                await session.scalar(
                    select(func.count())
                    .select_from(ChatMember)
                    .where(ChatMember.chat_id == chat_id)
                )
                == 2
            )
    finally:
        async with session_factory() as session:
            if chat_id is not None:
                await session.execute(delete(Chat).where(Chat.id == chat_id))
            await session.execute(
                delete(User).where(
                    User.id.in_((first_id, second_id, outsider_id))
                )
            )
            await session.commit()
        await engine.dispose()


@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="TEST_DATABASE_URL is required for PostgreSQL race verification",
)
@pytest.mark.asyncio
async def test_concurrent_reverse_order_open_creates_one_chat_without_orphan() -> None:
    assert TEST_DATABASE_URL is not None
    engine = create_async_engine(TEST_DATABASE_URL)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    service = SynchronizedChatService()
    first_id = uuid.uuid4()
    second_id = uuid.uuid4()

    try:
        async with session_factory() as session:
            session.add_all(
                [
                    User(
                        id=first_id,
                        username=f"chat-race-{first_id}",
                        password_hash="not-used",
                    ),
                    User(
                        id=second_id,
                        username=f"chat-race-{second_id}",
                        password_hash="not-used",
                    ),
                ]
            )
            await session.commit()
            orphan_ids_before = set(
                (
                    await session.scalars(
                        select(Chat.id)
                        .outerjoin(
                            DirectChatPair, DirectChatPair.chat_id == Chat.id
                        )
                        .where(DirectChatPair.chat_id.is_(None))
                    )
                ).all()
            )

        async def open_once(
            requester_id: uuid.UUID, target_id: uuid.UUID
        ) -> DirectChatView:
            async with session_factory() as session:
                return await service.open_direct_chat(
                    session, requester_id, target_id
                )

        first_result, second_result = await asyncio.gather(
            open_once(first_id, second_id),
            open_once(second_id, first_id),
        )
        assert first_result.chat.id == second_result.chat.id

        low_id, high_id = sorted((first_id, second_id), key=lambda value: value.int)
        async with session_factory() as session:
            pairs = (
                await session.scalars(
                    select(DirectChatPair).where(
                        DirectChatPair.user_low_id == low_id,
                        DirectChatPair.user_high_id == high_id,
                    )
                )
            ).all()
            assert len(pairs) == 1
            assert (
                await session.scalar(
                    select(func.count())
                    .select_from(ChatMember)
                    .where(ChatMember.chat_id == pairs[0].chat_id)
                )
                == 2
            )
            orphan_ids_after = set(
                (
                    await session.scalars(
                        select(Chat.id)
                        .outerjoin(
                            DirectChatPair, DirectChatPair.chat_id == Chat.id
                        )
                        .where(DirectChatPair.chat_id.is_(None))
                    )
                ).all()
            )
            assert orphan_ids_after == orphan_ids_before
    finally:
        async with session_factory() as session:
            pair_chat_ids = select(DirectChatPair.chat_id).where(
                DirectChatPair.user_low_id.in_((first_id, second_id)),
                DirectChatPair.user_high_id.in_((first_id, second_id)),
            )
            await session.execute(delete(Chat).where(Chat.id.in_(pair_chat_ids)))
            await session.execute(
                delete(User).where(User.id.in_((first_id, second_id)))
            )
            await session.commit()
        await engine.dispose()
