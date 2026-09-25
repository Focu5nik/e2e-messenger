import asyncio
import base64
import os
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.auth.dependencies import Principal
from app.auth.models import Device, User
from app.auth.schemas import LoginRequest
from app.auth.security import hash_password
from app.auth.service import AuthService
from app.chats.models import Chat, ChatMember, ChatReadState, DirectChatPair
from app.chats.read_service import ChatReadService
from app.chats.repository import ChatRepository
from app.config import Settings
from app.messages.models import DeviceMailbox, Message, MessageEnvelope
from app.messages.repository import MessageRepository
from app.messages.schemas import ClientEnvelopeRequest, SendMessageRequest
from app.messages.service import MessageService


TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")


class SynchronizedChatRepository(ChatRepository):
    def __init__(self) -> None:
        self.lock_attempts = 0
        self.both_ready = asyncio.Event()

    async def lock_chat(
        self,
        session: AsyncSession,
        requester_id: uuid.UUID,
        chat_id: uuid.UUID,
    ) -> Chat | None:
        self.lock_attempts += 1
        if self.lock_attempts == 2:
            self.both_ready.set()
        await self.both_ready.wait()
        return await super().lock_chat(session, requester_id, chat_id)


class PausingDeviceSetRepository(MessageRepository):
    def __init__(self) -> None:
        self.device_set_locked = asyncio.Event()
        self.release = asyncio.Event()
        self.lock_count = 0

    async def lock_device_set(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
    ) -> bool:
        locked = await super().lock_device_set(session, user_id)
        self.lock_count += 1
        if self.lock_count == 2:
            self.device_set_locked.set()
            await self.release.wait()
        return locked


async def wait_for_lock(
    session_factory: async_sessionmaker[AsyncSession],
    application_name: str,
) -> None:
    async with session_factory() as observer_session:
        async with asyncio.timeout(5):
            while True:
                await observer_session.execute(select(func.pg_stat_clear_snapshot()))
                waiting = await observer_session.scalar(
                    text(
                        """
                        SELECT count(*)
                        FROM pg_stat_activity
                        WHERE application_name = :application_name
                          AND wait_event_type = 'Lock'
                        """
                    ),
                    {"application_name": application_name},
                )
                if waiting == 1:
                    return
                await asyncio.sleep(0.01)


@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="TEST_DATABASE_URL is required for PostgreSQL mailbox locking verification",
)
@pytest.mark.asyncio
async def test_concurrent_sends_keep_sequences_contiguous_and_are_idempotent() -> None:
    assert TEST_DATABASE_URL is not None
    engine = create_async_engine(TEST_DATABASE_URL)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    alice_id = uuid.uuid4()
    bob_id = uuid.uuid4()
    alice_device_ids = [uuid.uuid4(), uuid.uuid4()]
    bob_device_id = uuid.uuid4()
    chat_id = uuid.uuid4()
    message_ids: list[uuid.UUID] = []

    try:
        async with session_factory() as session:
            session.add_all(
                [
                    User(
                        id=alice_id,
                        username=f"message-race-alice-{alice_id}",
                        password_hash="not-used",
                    ),
                    User(
                        id=bob_id,
                        username=f"message-race-bob-{bob_id}",
                        password_hash="not-used",
                    ),
                ]
            )
            await session.flush()
            session.add_all(
                [
                    Device(
                        id=device_id,
                        user_id=alice_id,
                        name="Concurrent sender",
                        last_seen_at=datetime.now(UTC),
                    )
                    for device_id in alice_device_ids
                ]
                + [
                    Device(
                        id=bob_device_id,
                        user_id=bob_id,
                        name="Recipient",
                        last_seen_at=datetime.now(UTC),
                    )
                ]
            )
            await session.flush()
            session.add_all(
                DeviceMailbox(device_id=device_id)
                for device_id in [*alice_device_ids, bob_device_id]
            )
            chat = Chat(id=chat_id)
            session.add(chat)
            await session.flush()
            low_id, high_id = sorted((alice_id, bob_id), key=lambda item: item.int)
            session.add_all(
                [
                    ChatMember(chat_id=chat_id, user_id=low_id),
                    ChatMember(chat_id=chat_id, user_id=high_id),
                ]
            )
            await session.flush()
            session.add(
                DirectChatPair(
                    chat_id=chat_id,
                    user_low_id=low_id,
                    user_high_id=high_id,
                )
            )
            await session.commit()

        async def send_once(
            service: MessageService,
            sender_device_id: uuid.UUID,
            client_message_id: uuid.UUID | None = None,
        ) -> uuid.UUID:
            async with session_factory() as session:
                result = await service.send(
                    session,
                    Principal(
                        user_id=alice_id,
                        device_id=sender_device_id,
                        session_id=uuid.uuid4(),
                    ),
                    SendMessageRequest(
                        chat_id=chat_id,
                        client_message_id=client_message_id or uuid.uuid4(),
                        envelopes=[
                            ClientEnvelopeRequest(
                                recipient_device_id=destination_id,
                                protocol_version=0,
                                envelope_type="PLAINTEXT",
                                payload=base64.b64encode(b"concurrent").decode(),
                            )
                            for destination_id in [bob_device_id, *(item for item in alice_device_ids if item != sender_device_id)]
                        ],
                    ),
                )
                return result.message.id

        sequence_service = MessageService(chat_repository=SynchronizedChatRepository())
        message_ids = list(
            await asyncio.gather(
                *(send_once(sequence_service, item) for item in alice_device_ids)
            )
        )

        async with session_factory() as session:
            sequences = list(
                (
                    await session.scalars(
                        select(MessageEnvelope.mailbox_seq)
                        .where(MessageEnvelope.message_id.in_(message_ids))
                        .where(MessageEnvelope.recipient_device_id == bob_device_id)
                        .order_by(MessageEnvelope.mailbox_seq)
                    )
                ).all()
            )
            mailbox = await session.get(DeviceMailbox, bob_device_id)
            assert sequences == [1, 2]
            assert mailbox is not None
            assert mailbox.last_seq == 2

        idempotency_service = MessageService(chat_repository=SynchronizedChatRepository())
        shared_client_message_id = uuid.uuid4()
        repeated_ids = list(
            await asyncio.gather(
                *(
                    send_once(
                        idempotency_service,
                        alice_device_ids[0],
                        shared_client_message_id,
                    )
                    for _ in range(2)
                )
            )
        )
        assert repeated_ids[0] == repeated_ids[1]
        message_ids.extend(repeated_ids)

        async with session_factory() as session:
            sequences = list(
                (
                    await session.scalars(
                        select(MessageEnvelope.mailbox_seq)
                        .join(Message, Message.id == MessageEnvelope.message_id)
                        .where(Message.chat_id == chat_id)
                        .where(MessageEnvelope.recipient_device_id == bob_device_id)
                        .order_by(MessageEnvelope.mailbox_seq)
                    )
                ).all()
            )
            mailbox = await session.get(DeviceMailbox, bob_device_id)
            assert sequences == [1, 2, 3]
            assert mailbox is not None
            assert mailbox.last_seq == 3

            chat = await session.get(Chat, chat_id)
            assert chat is not None and chat.last_message_seq == 3
            assert list((await session.scalars(
                select(Message.chat_seq).where(Message.chat_id == chat_id).order_by(Message.chat_seq)
            )).all()) == [1, 2, 3]

            envelope = await session.scalar(
                select(MessageEnvelope).where(
                    MessageEnvelope.message_id == repeated_ids[0],
                    MessageEnvelope.recipient_device_id == bob_device_id,
                )
            )
            assert envelope is not None
            envelope_id = envelope.id

        # Two ACK requests racing after a lost response must converge on the
        # first delivery/purge timestamps and preserve the idempotency row.
        async def acknowledge_once() -> tuple[datetime, datetime]:
            async with session_factory() as session:
                acknowledged = await MessageService().acknowledge(
                    session,
                    Principal(
                        user_id=bob_id,
                        device_id=bob_device_id,
                        session_id=uuid.uuid4(),
                    ),
                    envelope_id,
                )
                assert acknowledged.payload is None
                assert acknowledged.delivered_at is not None
                assert acknowledged.payload_purged_at is not None
                return acknowledged.delivered_at, acknowledged.payload_purged_at

        receipts = await asyncio.gather(acknowledge_once(), acknowledge_once())
        assert receipts[0] == receipts[1]
        assert receipts[0][0] == receipts[0][1]
        recovered_id = await send_once(
            MessageService(), alice_device_ids[0], shared_client_message_id
        )
        assert recovered_id == repeated_ids[0]

        async def advance_once(position: int) -> int:
            async with session_factory() as session:
                saved = await ChatReadService(ChatRepository(), MessageRepository()).advance(
                    session,
                    Principal(user_id=bob_id, device_id=bob_device_id, session_id=uuid.uuid4()),
                    chat_id, position,
                )
                return saved.last_read_seq

        cursors = await asyncio.gather(*(advance_once(position) for position in (1, 3, 2, 3, 1)))
        assert max(cursors) == 3
        async with session_factory() as session:
            assert (await session.get(ChatReadState, (chat_id, bob_id))).last_read_seq == 3
            retained = await session.get(MessageEnvelope, envelope_id)
            assert retained is not None
            assert retained.payload is None
            assert retained.mailbox_seq == 3
            mailbox = await session.get(DeviceMailbox, bob_device_id)
            assert mailbox is not None
            assert mailbox.last_seq == 3
    finally:
        async with session_factory() as session:
            if message_ids:
                await session.execute(
                    delete(MessageEnvelope).where(
                        MessageEnvelope.message_id.in_(message_ids)
                    )
                )
                await session.execute(
                    delete(Message).where(Message.id.in_(message_ids))
                )
            await session.execute(delete(Chat).where(Chat.id == chat_id))
            await session.execute(
                delete(User).where(User.id.in_((alice_id, bob_id)))
            )
            await session.commit()
        await engine.dispose()


@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="TEST_DATABASE_URL is required for PostgreSQL device-set locking verification",
)
@pytest.mark.asyncio
async def test_device_set_mutations_wait_for_in_flight_send() -> None:
    assert TEST_DATABASE_URL is not None
    engine = create_async_engine(TEST_DATABASE_URL)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    settings = Settings(
        database_url=TEST_DATABASE_URL,
        jwt_secret="test-only-secret-that-is-at-least-32-characters",
        _env_file=None,
    )
    auth_service = AuthService(settings)
    alice_id = uuid.uuid4()
    bob_id = uuid.uuid4()
    alice_device_id = uuid.uuid4()
    bob_device_id = uuid.uuid4()
    new_bob_device_id = uuid.uuid4()
    chat_id = uuid.uuid4()
    message_ids: list[uuid.UUID] = []
    password = "correct horse"

    async def send_with_pause(
        recipient_device_ids: list[uuid.UUID],
    ) -> tuple[PausingDeviceSetRepository, asyncio.Task[uuid.UUID]]:
        repository = PausingDeviceSetRepository()
        client_message_id = uuid.uuid4()

        async def send_once() -> uuid.UUID:
            async with session_factory() as session:
                stored = await MessageService(repository).send(
                    session,
                    Principal(
                        user_id=alice_id,
                        device_id=alice_device_id,
                        session_id=uuid.uuid4(),
                    ),
                    SendMessageRequest(
                        chat_id=chat_id,
                        client_message_id=client_message_id,
                        envelopes=[
                            ClientEnvelopeRequest(
                                recipient_device_id=device_id,
                                protocol_version=0,
                                envelope_type="PLAINTEXT",
                                payload=base64.b64encode(b"locked target").decode(),
                            )
                            for device_id in recipient_device_ids
                        ],
                    ),
                )
                return stored.message.id

        task = asyncio.create_task(send_once())
        await repository.device_set_locked.wait()
        return repository, task

    try:
        async with session_factory() as session:
            session.add_all(
                [
                    User(
                        id=alice_id,
                        username=f"device-set-alice-{alice_id}",
                        password_hash="not-used",
                    ),
                    User(
                        id=bob_id,
                        username=f"device-set-bob-{bob_id}",
                        password_hash=hash_password(password),
                    ),
                ]
            )
            await session.flush()
            session.add_all(
                [
                    Device(
                        id=alice_device_id,
                        user_id=alice_id,
                        name="Sender",
                        last_seen_at=datetime.now(UTC),
                    ),
                    Device(
                        id=bob_device_id,
                        user_id=bob_id,
                        name="Original recipient",
                        last_seen_at=datetime.now(UTC),
                    ),
                ]
            )
            await session.flush()
            session.add_all(
                [
                    DeviceMailbox(device_id=alice_device_id),
                    DeviceMailbox(device_id=bob_device_id),
                ]
            )
            session.add(Chat(id=chat_id))
            await session.flush()
            low_id, high_id = sorted((alice_id, bob_id), key=lambda item: item.int)
            session.add_all(
                [
                    ChatMember(chat_id=chat_id, user_id=low_id),
                    ChatMember(chat_id=chat_id, user_id=high_id),
                    DirectChatPair(
                        chat_id=chat_id,
                        user_low_id=low_id,
                        user_high_id=high_id,
                    ),
                ]
            )
            await session.commit()

        add_repository, add_send_task = await send_with_pause([bob_device_id])
        add_application_name = f"device-set-add-{new_bob_device_id}"

        async def add_device() -> None:
            async with session_factory() as session:
                await session.execute(
                    select(
                        func.set_config(
                            "application_name", add_application_name, False
                        )
                    )
                )
                await auth_service.login(
                    session,
                    LoginRequest(
                        username=f"device-set-bob-{bob_id}",
                        password=password,
                        device_id=new_bob_device_id,
                        device_name="New recipient",
                    ),
                )

        add_task = asyncio.create_task(add_device())
        try:
            await wait_for_lock(session_factory, add_application_name)
        finally:
            add_repository.release.set()
            add_results = await asyncio.gather(add_send_task, add_task)
        added_message_id, _ = add_results
        message_ids.append(added_message_id)

        revoke_repository, revoke_send_task = await send_with_pause(
            [bob_device_id, new_bob_device_id]
        )
        revoke_application_name = f"device-set-revoke-{new_bob_device_id}"

        async def revoke_device() -> None:
            async with session_factory() as session:
                await session.execute(
                    select(
                        func.set_config(
                            "application_name", revoke_application_name, False
                        )
                    )
                )
                await auth_service.revoke_device(
                    session,
                    Principal(
                        user_id=bob_id,
                        device_id=bob_device_id,
                        session_id=uuid.uuid4(),
                    ),
                    new_bob_device_id,
                )

        revoke_task = asyncio.create_task(revoke_device())
        try:
            await wait_for_lock(session_factory, revoke_application_name)
        finally:
            revoke_repository.release.set()
            revoke_results = await asyncio.gather(revoke_send_task, revoke_task)
        revoked_message_id, _ = revoke_results
        message_ids.append(revoked_message_id)

        async with session_factory() as session:
            envelope_counts = dict(
                (
                    await session.execute(
                        select(
                            MessageEnvelope.message_id,
                            func.count(MessageEnvelope.id),
                        )
                        .where(MessageEnvelope.message_id.in_(message_ids))
                        .group_by(MessageEnvelope.message_id)
                    )
                ).all()
            )
            new_device = await session.get(Device, new_bob_device_id)
            assert envelope_counts == {
                added_message_id: 1,
                revoked_message_id: 2,
            }
            assert new_device is not None
            assert new_device.revoked_at is not None
    finally:
        async with session_factory() as session:
            chat_message_ids = select(Message.id).where(Message.chat_id == chat_id)
            await session.execute(
                delete(MessageEnvelope).where(
                    MessageEnvelope.message_id.in_(chat_message_ids)
                )
            )
            await session.execute(delete(Message).where(Message.chat_id == chat_id))
            await session.execute(delete(Chat).where(Chat.id == chat_id))
            await session.execute(
                delete(User).where(User.id.in_((alice_id, bob_id)))
            )
            await session.commit()
        await engine.dispose()
