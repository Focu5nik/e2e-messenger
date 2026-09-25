import asyncio
import os
import uuid
from dataclasses import dataclass

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.auth.models import User
from app.auth.principal import Principal
from app.chats.errors import ChatNotFoundError
from app.chats.models import Chat, ChatReadState
from app.chats.read_service import ChatReadService
from app.chats.repository import ChatRepository
from app.messages.models import DeviceMailbox, Message, MessageEnvelope
from app.messages.repository import MessageRepository
from app.messages.schemas import SendMessageRequest
from app.messages.service import MessageService
from test_messages import create_authenticated_user, create_direct_chat, send_body
from test_messages_postgres import wait_for_lock


pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_DATABASE_URL"),
    reason="TEST_DATABASE_URL is required for PostgreSQL read/commit verification",
)


@dataclass
class ReadScenario:
    sessions: async_sessionmaker
    chat_id: uuid.UUID
    sender: Principal
    readers: list[Principal]
    request: SendMessageRequest


@pytest.fixture
async def read_scenario():
    engine = create_async_engine(os.environ["TEST_DATABASE_URL"])
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    user_ids = []
    chat_id = None
    try:
        alice, sender_devices, _ = await create_authenticated_user(
            sessions, "read-race-a-" + uuid.uuid4().hex
        )
        user_ids.append(alice.id)
        bob, reader_devices, _ = await create_authenticated_user(
            sessions, "read-race-b-" + uuid.uuid4().hex, device_count=3
        )
        user_ids.append(bob.id)
        chat = await create_direct_chat(sessions, alice.id, bob.id)
        chat_id = chat.id
        yield ReadScenario(
            sessions,
            chat.id,
            Principal(alice.id, sender_devices[0].id, uuid.uuid4()),
            [Principal(bob.id, device.id, uuid.uuid4()) for device in reader_devices],
            SendMessageRequest.model_validate(send_body(chat.id, reader_devices)),
        )
    finally:
        async with sessions() as session:
            if chat_id is not None:
                await session.execute(delete(MessageEnvelope).where(
                    MessageEnvelope.message_id.in_(select(Message.id).where(Message.chat_id == chat_id))
                ))
                await session.execute(delete(Message).where(Message.chat_id == chat_id))
                await session.execute(delete(Chat).where(Chat.id == chat_id))
            await session.execute(delete(User).where(User.id.in_(user_ids)))
            await session.commit()
        await engine.dispose()


def read_service():
    return ChatReadService(ChatRepository(), MessageRepository())


async def send(scenario, *, request=None, application_name=None):
    async with scenario.sessions() as session:
        if application_name:
            await session.execute(select(func.set_config("application_name", application_name, True)))
        return await MessageService().send(
            session, scenario.sender,
            request or scenario.request.model_copy(update={"client_message_id": uuid.uuid4()}),
        )


def pause_commit(monkeypatch, session, reached, release, *, rollback=False):
    commit = session.commit

    async def paused():
        await session.flush()
        reached.set()
        await release.wait()
        if rollback:
            await session.rollback()
            raise RuntimeError("controlled rollback")
        await commit()

    monkeypatch.setattr(session, "commit", paused)


@pytest.mark.parametrize("rollback", [False, True])
async def test_send_positions_wait_for_commit_and_rollback_retry(read_scenario, monkeypatch, rollback):
    scenario = read_scenario
    reached, release = asyncio.Event(), asyncio.Event()
    name = "send-wait-" + uuid.uuid4().hex

    async def first_send():
        async with scenario.sessions() as session:
            pause_commit(monkeypatch, session, reached, release, rollback=rollback)
            if rollback:
                with pytest.raises(RuntimeError, match="controlled rollback"):
                    await MessageService().send(session, scenario.sender, scenario.request)
                return None
            return await MessageService().send(session, scenario.sender, scenario.request)

    async with asyncio.timeout(10), asyncio.TaskGroup() as tasks:
        first = tasks.create_task(first_send())
        await reached.wait()
        second = tasks.create_task(send(scenario, application_name=name))
        try:
            await wait_for_lock(scenario.sessions, name)
            assert not second.done()
            async with scenario.sessions() as observer:
                assert await observer.scalar(select(func.count()).select_from(Message).where(
                    Message.chat_id == scenario.chat_id
                )) == 0
                assert (await observer.get(Chat, scenario.chat_id)).last_message_seq == 0
        finally:
            release.set()

    assert second.result().message.chat_seq == (1 if rollback else 2)
    retried = await send(scenario, request=scenario.request)
    if rollback:
        assert retried.message.chat_seq == 2
    else:
        assert retried.message.id == first.result().message.id
        assert retried.message.chat_seq == 1
    async with scenario.sessions() as session:
        assert list((await session.scalars(select(Message.chat_seq).where(
            Message.chat_id == scenario.chat_id
        ).order_by(Message.chat_seq))).all()) == [1, 2]


async def test_first_read_insert_serializes_devices_and_lower_cursor(read_scenario, monkeypatch):
    scenario = read_scenario
    for _ in range(3):
        await send(scenario)
    reached, release = asyncio.Event(), asyncio.Event()
    names = ["read-wait-" + uuid.uuid4().hex for _ in range(2)]

    async def advance(position, principal, *, paused=False, name=None):
        async with scenario.sessions() as session:
            if name:
                await session.execute(select(func.set_config("application_name", name, True)))
            if paused:
                pause_commit(monkeypatch, session, reached, release)
            return await read_service().advance(session, principal, scenario.chat_id, position)

    async with asyncio.timeout(10), asyncio.TaskGroup() as tasks:
        first = tasks.create_task(advance(1, scenario.readers[0], paused=True))
        await reached.wait()
        high = tasks.create_task(advance(3, scenario.readers[1], name=names[0]))
        lower = tasks.create_task(advance(2, scenario.readers[2], name=names[1]))
        try:
            for name in names:
                await wait_for_lock(scenario.sessions, name)
            async with scenario.sessions() as observer:
                assert await observer.get(ChatReadState, (scenario.chat_id, scenario.readers[0].user_id)) is None
        finally:
            release.set()
    assert first.result().last_read_seq == 1
    assert high.result().last_read_seq == 3
    assert lower.result().last_read_seq in (2, 3)
    saved = await advance(2, scenario.readers[2])
    assert saved.last_read_seq == 3
    async with scenario.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(ChatReadState).where(
            ChatReadState.chat_id == scenario.chat_id
        )) == 1
        assert (await session.get(ChatReadState, (scenario.chat_id, scenario.readers[0].user_id))).last_read_seq == 3


async def test_send_and_read_keep_metadata_after_payload_purge(read_scenario, monkeypatch):
    scenario = read_scenario
    stored = await send(scenario)
    envelope = next(item for item in stored.envelopes if item.recipient_device_id == scenario.readers[0].device_id)
    async with scenario.sessions() as session:
        await MessageService().acknowledge(session, scenario.readers[0], envelope.id)
    reached, release = asyncio.Event(), asyncio.Event()
    name = "read-during-send-" + uuid.uuid4().hex

    async def paused_send():
        async with scenario.sessions() as session:
            pause_commit(monkeypatch, session, reached, release)
            return await MessageService().send(session, scenario.sender, scenario.request)

    async def advance():
        async with scenario.sessions() as session:
            await session.execute(select(func.set_config("application_name", name, True)))
            return await read_service().advance(session, scenario.readers[0], scenario.chat_id, 1)

    async with asyncio.timeout(10), asyncio.TaskGroup() as tasks:
        sent = tasks.create_task(paused_send())
        await reached.wait()
        read = tasks.create_task(advance())
        try:
            await wait_for_lock(scenario.sessions, name)
        finally:
            release.set()
    assert sent.result().message.chat_seq == 2
    assert read.result().last_read_seq == 1
    async with scenario.sessions() as session:
        retained = await session.get(MessageEnvelope, envelope.id)
        assert retained.payload is None and retained.delivered_at is not None
        assert retained.payload_purged_at is not None and retained.mailbox_seq == 1
        assert (await session.get(Message, stored.message.id)).chat_seq == 1
        assert (await session.get(DeviceMailbox, scenario.readers[0].device_id)).last_seq == 2
        assert await session.scalar(select(func.count()).select_from(MessageEnvelope).where(
            MessageEnvelope.message_id == stored.message.id,
            MessageEnvelope.payload.is_not(None),
        )) == 2


async def test_nonmember_cannot_lock_chat_while_transaction_remains_open(read_scenario):
    scenario = read_scenario
    outsider = Principal(uuid.uuid4(), uuid.uuid4(), uuid.uuid4())
    async with asyncio.timeout(10), scenario.sessions() as rejected:
        with pytest.raises(ChatNotFoundError):
            await read_service().advance(rejected, outsider, scenario.chat_id, 0)
        assert await ChatRepository().lock_chat(rejected, outsider.user_id, scenario.chat_id) is None
        # Keep the rejected transaction open while a member writes the same chat.
        assert rejected.in_transaction()
        stored = await send(scenario)
        assert stored.message.chat_seq == 1
