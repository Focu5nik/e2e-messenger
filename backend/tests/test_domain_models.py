import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.exc import InvalidRequestError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app.auth.models import AuthSession, Device, RefreshTokenHistory, User
from app.chats.models import Chat, ChatMember, ChatReadState, DirectChatPair
from app.messages.models import DeviceMailbox, Message, MessageEnvelope


@pytest.fixture
async def domain_graph(session_factory: async_sessionmaker[AsyncSession]) -> None:
    now = datetime.now(UTC)
    low_user = User(id=uuid.UUID(int=1), username="alice", password_hash="unused")
    high_user = User(id=uuid.UUID(int=2), username="bob", password_hash="unused")
    sender = Device(
        id=uuid.uuid4(), name="Sender", user=low_user, mailbox=DeviceMailbox()
    )
    recipient = Device(id=uuid.uuid4(), name="Recipient", user=high_user)
    auth_session = AuthSession(
        device=sender,
        refresh_token_hash="a" * 64,
        refresh_expires_at=now + timedelta(days=1),
        refresh_token_history=[RefreshTokenHistory(token_hash="b" * 64)],
    )
    chat = Chat(members=[ChatMember(user=low_user), ChatMember(user=high_user)])
    async with session_factory() as session:
        session.add_all([chat, auth_session, recipient])
        # Composite membership constraints require members before the pair.
        await session.flush()
        chat.direct_pair = DirectChatPair(user_low=low_user, user_high=high_user)
        session.add(ChatReadState(chat_id=chat.id, user_id=low_user.id, last_read_seq=0))
        message = Message(
            chat=chat,
            chat_seq=1,
            sender_user=low_user,
            sender_device=sender,
            client_message_id=uuid.uuid4(),
            envelopes=[
                MessageEnvelope(
                    recipient_device=recipient,
                    recipient_user=high_user,
                    mailbox_seq=1,
                    protocol_version=0,
                    envelope_type="PLAINTEXT",
                    payload=b"model-test",
                    expires_at=now + timedelta(days=1),
                )
            ],
        )
        session.add(message)
        await session.commit()


@pytest.mark.parametrize(
    ("model", "relationship_name", "target_model"),
    [
        (Chat, "members", ChatMember),
        (Chat, "direct_pair", DirectChatPair),
        (ChatMember, "chat", Chat),
        (ChatMember, "user", User),
        (ChatMember, "read_state", ChatReadState),
        (ChatReadState, "member", ChatMember),
        (DirectChatPair, "chat", Chat),
        (DirectChatPair, "user_low", User),
        (DirectChatPair, "user_high", User),
        (DirectChatPair, "low_member", ChatMember),
        (DirectChatPair, "high_member", ChatMember),
        (Message, "chat", Chat),
        (Message, "sender_user", User),
        (Message, "sender_device", Device),
        (MessageEnvelope, "recipient_device", Device),
        (MessageEnvelope, "recipient_user", User),
        (DeviceMailbox, "device", Device),
        (Device, "mailbox", DeviceMailbox),
        (AuthSession, "refresh_token_history", RefreshTokenHistory),
        (RefreshTokenHistory, "auth_session", AuthSession),
    ],
)
async def test_domain_relationship_requires_explicit_loading(
    session_factory: async_sessionmaker[AsyncSession],
    domain_graph: None,
    model: type,
    relationship_name: str,
    target_model: type,
) -> None:
    async with session_factory() as session:
        instance = await session.scalar(select(model))
        assert instance is not None
        with pytest.raises(InvalidRequestError, match="lazy='raise'"):
            getattr(instance, relationship_name)

        instances = await session.scalars(
            select(model).options(selectinload(getattr(model, relationship_name)))
        )
        related = [getattr(item, relationship_name) for item in instances]
        targets = [
            target
            for value in related
            for target in (value if isinstance(value, list) else [value])
            if target is not None
        ]
        assert targets
        assert all(isinstance(target, target_model) for target in targets)


@pytest.mark.parametrize("load_relationships", [False, True])
async def test_auth_session_delete_cascades_refresh_history(
    session_factory: async_sessionmaker[AsyncSession],
    domain_graph: None,
    load_relationships: bool,
) -> None:
    async with session_factory() as session:
        statement = select(AuthSession)
        if load_relationships:
            statement = statement.options(selectinload(AuthSession.refresh_token_history))
        auth_session = await session.scalar(statement)
        assert auth_session is not None
        await session.delete(auth_session)
        await session.commit()
        assert await session.scalar(select(RefreshTokenHistory)) is None


@pytest.mark.parametrize("load_relationships", [False, True])
async def test_device_delete_cascades_mailbox(
    session_factory: async_sessionmaker[AsyncSession],
    load_relationships: bool,
) -> None:
    async with session_factory() as session:
        session.add(
            Device(
                id=uuid.uuid4(),
                name="Browser",
                user=User(username="alice", password_hash="unused"),
                mailbox=DeviceMailbox(),
            )
        )
        await session.commit()

    async with session_factory() as session:
        statement = select(Device)
        if load_relationships:
            statement = statement.options(selectinload(Device.mailbox))
        device = await session.scalar(statement)
        assert device is not None
        await session.delete(device)
        await session.commit()
        assert await session.scalar(select(DeviceMailbox)) is None


@pytest.mark.parametrize("load_relationships", [False, True])
async def test_chat_delete_preserves_database_cascades(
    session_factory: async_sessionmaker[AsyncSession],
    load_relationships: bool,
) -> None:
    low_user = User(id=uuid.UUID(int=1), username="alice", password_hash="unused")
    high_user = User(id=uuid.UUID(int=2), username="bob", password_hash="unused")
    async with session_factory() as session:
        chat = Chat(members=[ChatMember(user=low_user), ChatMember(user=high_user)])
        session.add(chat)
        await session.flush()
        chat.direct_pair = DirectChatPair(user_low=low_user, user_high=high_user)
        await session.commit()

    async with session_factory() as session:
        statement = select(Chat)
        if load_relationships:
            statement = statement.options(
                selectinload(Chat.members), selectinload(Chat.direct_pair)
            )
        chat = await session.scalar(statement)
        assert chat is not None
        await session.delete(chat)
        await session.commit()

    async with session_factory() as session:
        assert await session.scalar(select(ChatMember)) is None
        assert await session.scalar(select(DirectChatPair)) is None
        assert len((await session.scalars(select(User))).all()) == 2
