import base64
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.auth.dependencies import Principal
from app.auth.models import AuthSession, Device, User
from app.auth.security import create_access_token
from app.chats.models import Chat, ChatMember, DirectChatPair
from app.config import get_settings
from app.messages.models import DeviceMailbox, Message, MessageEnvelope
from app.messages.schemas import MAX_ENVELOPE_PAYLOAD_BYTES
from app.messages.service import MessageService


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def create_device(
    session: AsyncSession,
    user_id: uuid.UUID,
    name: str,
    *,
    revoked_at: datetime | None = None,
) -> Device:
    device = Device(
        id=uuid.uuid4(),
        user_id=user_id,
        name=name,
        last_seen_at=datetime.now(UTC),
        revoked_at=revoked_at,
    )
    session.add(device)
    await session.flush()
    session.add(DeviceMailbox(device_id=device.id))
    return device


async def create_authenticated_user(
    session_factory: async_sessionmaker[AsyncSession],
    username: str,
    *,
    device_count: int = 1,
) -> tuple[User, list[Device], str]:
    user = User(
        id=uuid.uuid4(),
        username=username,
        password_hash="not-used-by-message-tests",
    )
    now = datetime.now(UTC)
    async with session_factory() as session:
        session.add(user)
        await session.flush()
        devices = [
            await create_device(session, user.id, f"{username}-{index}")
            for index in range(device_count)
        ]
        auth_session = AuthSession(
            id=uuid.uuid4(),
            device_id=devices[0].id,
            refresh_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
            refresh_cookie_bound=True,
            last_used_at=now,
            refresh_expires_at=now + timedelta(days=1),
        )
        session.add(auth_session)
        await session.commit()
        await session.refresh(user)

    token = create_access_token(
        user_id=user.id,
        device_id=devices[0].id,
        session_id=auth_session.id,
        settings=get_settings(),
    )
    return user, devices, token


async def create_direct_chat(
    session_factory: async_sessionmaker[AsyncSession],
    first_user_id: uuid.UUID,
    second_user_id: uuid.UUID,
) -> Chat:
    low_id, high_id = sorted(
        (first_user_id, second_user_id), key=lambda item: item.int
    )
    chat = Chat(id=uuid.uuid4())
    async with session_factory() as session:
        session.add(chat)
        await session.flush()
        session.add_all(
            [
                ChatMember(chat_id=chat.id, user_id=low_id),
                ChatMember(chat_id=chat.id, user_id=high_id),
            ]
        )
        await session.flush()
        session.add(
            DirectChatPair(
                chat_id=chat.id,
                user_low_id=low_id,
                user_high_id=high_id,
            )
        )
        await session.commit()
        await session.refresh(chat)
    return chat


def send_body(
    chat_id: uuid.UUID,
    recipient_devices: list[Device],
    *,
    client_message_id: uuid.UUID | None = None,
    payloads: list[bytes] | None = None,
) -> dict[str, object]:
    resolved_payloads = payloads or [
        f"payload-{index}".encode() for index in range(len(recipient_devices))
    ]
    return {
        "chat_id": str(chat_id),
        "client_message_id": str(client_message_id or uuid.uuid4()),
        "envelopes": [
            {
                "recipient_device_id": str(device.id),
                "protocol_version": 0,
                "envelope_type": "PLAINTEXT",
                "payload": base64.b64encode(payload).decode(),
            }
            for device, payload in zip(
                recipient_devices, resolved_payloads, strict=True
            )
        ],
    }


@pytest.mark.asyncio
async def test_login_creates_mailbox_with_new_device(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    device_id = uuid.uuid4()
    assert (
        await client.post(
            "/auth/register",
            json={"username": "login-mailbox", "password": "correct horse"},
        )
    ).status_code == 201
    response = await client.post(
        "/auth/login",
        headers={"Origin": str(get_settings().frontend_origin).rstrip("/")},
        json={
            "username": "login-mailbox",
            "password": "correct horse",
            "device_id": str(device_id),
            "device_name": "Mailbox browser",
        },
    )
    assert response.status_code == 200

    async with session_factory() as session:
        mailbox = await session.get(DeviceMailbox, device_id)
        assert mailbox is not None
        assert mailbox.last_seq == 0


@pytest.mark.asyncio
async def test_destination_discovery_and_send_store_one_opaque_envelope_per_device(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, alice_devices, alice_token = await create_authenticated_user(
        session_factory, "alice-message"
    )
    bob, bob_devices, _ = await create_authenticated_user(
        session_factory, "bob-message", device_count=2
    )
    outsider, outsider_devices, outsider_token = await create_authenticated_user(
        session_factory, "outsider-message"
    )
    chat = await create_direct_chat(session_factory, alice.id, bob.id)

    assert (
        await client.get(f"/chats/{chat.id}/destination-devices")
    ).status_code == 401
    destination_response = await client.get(
        f"/chats/{chat.id}/destination-devices", headers=bearer(alice_token)
    )
    assert destination_response.status_code == 200
    assert destination_response.json() == [
        {"id": str(device.id), "protocol_version": 0}
        for device in sorted(bob_devices, key=lambda item: item.id.int)
    ]
    assert (
        await client.get(
            f"/chats/{chat.id}/destination-devices",
            headers=bearer(outsider_token),
        )
    ).status_code == 404

    payloads_by_id = {
        bob_devices[0].id: b"\xff\x00opaque-a",
        bob_devices[1].id: b"\x80opaque-b",
    }
    client_message_id = uuid.uuid4()
    body = send_body(
        chat.id,
        bob_devices,
        client_message_id=client_message_id,
        payloads=[payloads_by_id[device.id] for device in bob_devices],
    )
    send_response = await client.post(
        "/messages", headers=bearer(alice_token), json=body
    )
    assert send_response.status_code == 201, send_response.text
    sent = send_response.json()
    assert sent["chat_id"] == str(chat.id)
    assert sent["sender_user_id"] == str(alice.id)
    assert sent["sender_device_id"] == str(alice_devices[0].id)
    assert sent["client_message_id"] == str(client_message_id)
    assert {item["recipient_device_id"] for item in sent["envelopes"]} == {
        str(device.id) for device in bob_devices
    }

    async with session_factory() as session:
        messages = (await session.scalars(select(Message))).all()
        envelopes = (
            await session.scalars(
                select(MessageEnvelope).order_by(
                    MessageEnvelope.recipient_device_id
                )
            )
        ).all()
        assert len(messages) == 1
        assert len(envelopes) == 2
        assert {item.payload for item in envelopes} == set(payloads_by_id.values())
        assert all(item.mailbox_seq == 1 for item in envelopes)
        assert all(item.delivered_at is None for item in envelopes)
        assert all(item.payload_purged_at is None for item in envelopes)
        assert all(item.expires_at - item.created_at == timedelta(days=45) for item in envelopes)
        assert (
            await session.scalar(
                select(func.count()).select_from(MessageEnvelope).where(
                    MessageEnvelope.recipient_device_id
                    == outsider_devices[0].id
                )
            )
        ) == 0


@pytest.mark.asyncio
async def test_send_requires_exact_targets_and_rejects_bad_envelopes_atomically(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, _, alice_token = await create_authenticated_user(
        session_factory, "alice-validation"
    )
    bob, bob_devices, _ = await create_authenticated_user(
        session_factory, "bob-validation", device_count=2
    )
    outsider, outsider_devices, _ = await create_authenticated_user(
        session_factory, "outsider-validation"
    )
    chat = await create_direct_chat(session_factory, alice.id, bob.id)

    stale_target_cases = (
        bob_devices[:1],
        [*bob_devices, outsider_devices[0]],
    )
    for targets in stale_target_cases:
        response = await client.post(
            "/messages",
            headers=bearer(alice_token),
            json=send_body(chat.id, targets),
        )
        assert response.status_code == 409
        assert response.json() == {
            "detail": {
                "code": "delivery_targets_changed",
                "message": "Destination devices changed; refresh and retry.",
            }
        }

    duplicate_body = send_body(chat.id, [bob_devices[0], bob_devices[0]])
    duplicate_response = await client.post(
        "/messages", headers=bearer(alice_token), json=duplicate_body
    )
    assert duplicate_response.status_code == 422

    invalid_bodies = []
    for mutation in (
        {"protocol_version": 1},
        {"envelope_type": "RATCHET"},
        {"payload": "not-base64"},
        {
            "payload": base64.b64encode(
                b"x" * (MAX_ENVELOPE_PAYLOAD_BYTES + 1)
            ).decode()
        },
    ):
        body = send_body(chat.id, bob_devices)
        body["envelopes"][0].update(mutation)  # type: ignore[index, union-attr]
        invalid_bodies.append(body)

    for body in invalid_bodies:
        response = await client.post(
            "/messages", headers=bearer(alice_token), json=body
        )
        assert response.status_code == 422

    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Message)) == 0
        assert (
            await session.scalar(select(func.count()).select_from(MessageEnvelope))
            == 0
        )
        mailboxes = (
            await session.scalars(
                select(DeviceMailbox).where(
                    DeviceMailbox.device_id.in_(
                        [device.id for device in bob_devices]
                    )
                )
            )
        ).all()
        assert all(mailbox.last_seq == 0 for mailbox in mailboxes)

    # Keep the otherwise intentionally unused user explicit in the setup.
    assert outsider.id != alice.id


@pytest.mark.asyncio
async def test_idempotent_retry_returns_original_before_semantic_revalidation(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, _, alice_token = await create_authenticated_user(
        session_factory, "alice-idempotent"
    )
    bob, bob_devices, _ = await create_authenticated_user(
        session_factory, "bob-idempotent"
    )
    outsider, outsider_devices, _ = await create_authenticated_user(
        session_factory, "outsider-idempotent"
    )
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    client_message_id = uuid.uuid4()
    original_body = send_body(
        chat.id,
        bob_devices,
        client_message_id=client_message_id,
        payloads=[b"original"],
    )
    original = await client.post(
        "/messages", headers=bearer(alice_token), json=original_body
    )
    assert original.status_code == 201

    changed_retry = {
        "chat_id": str(uuid.uuid4()),
        "client_message_id": str(client_message_id),
        "envelopes": [
            {
                "recipient_device_id": str(outsider_devices[0].id),
                "protocol_version": 999,
                "envelope_type": "UNSUPPORTED",
                "payload": "not-base64",
            }
        ],
    }
    repeated = await client.post(
        "/messages", headers=bearer(alice_token), json=changed_retry
    )
    assert repeated.status_code == 201
    assert repeated.json() == original.json()

    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Message)) == 1
        assert (
            await session.scalar(select(func.count()).select_from(MessageEnvelope))
            == 1
        )
    assert outsider.id != bob.id


@pytest.mark.asyncio
async def test_device_set_change_is_retryable_and_does_not_consume_sequence(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, _, alice_token = await create_authenticated_user(
        session_factory, "alice-target-change"
    )
    bob, bob_devices, _ = await create_authenticated_user(
        session_factory, "bob-target-change"
    )
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    stale_body = send_body(chat.id, bob_devices)

    async with session_factory() as session:
        new_device = await create_device(session, bob.id, "new-bob-device")
        await session.commit()

    response = await client.post(
        "/messages", headers=bearer(alice_token), json=stale_body
    )
    assert response.status_code == 409

    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Message)) == 0
        mailboxes = (
            await session.scalars(
                select(DeviceMailbox).where(
                    DeviceMailbox.device_id.in_([bob_devices[0].id, new_device.id])
                )
            )
        ).all()
        assert all(mailbox.last_seq == 0 for mailbox in mailboxes)


@pytest.mark.asyncio
async def test_mailbox_is_device_scoped_ordered_and_paginated(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, _, alice_token = await create_authenticated_user(
        session_factory, "alice-mailbox"
    )
    bob, bob_devices, bob_token = await create_authenticated_user(
        session_factory, "bob-mailbox"
    )
    chat = await create_direct_chat(session_factory, alice.id, bob.id)

    for payload in (b"first", b"second"):
        response = await client.post(
            "/messages",
            headers=bearer(alice_token),
            json=send_body(chat.id, bob_devices, payloads=[payload]),
        )
        assert response.status_code == 201

    first_page = await client.get(
        "/messages/mailbox?after_seq=0&limit=1", headers=bearer(bob_token)
    )
    assert first_page.status_code == 200
    first_payload = first_page.json()
    assert first_payload["next_seq"] == 1
    assert first_payload["has_more"] is True
    assert len(first_payload["envelopes"]) == 1
    assert first_payload["envelopes"][0]["mailbox_seq"] == 1
    assert first_payload["envelopes"][0]["chat_id"] == str(chat.id)
    assert first_payload["envelopes"][0]["sender_user_id"] == str(alice.id)

    second_page = await client.get(
        "/messages/mailbox?after_seq=1&limit=1", headers=bearer(bob_token)
    )
    assert second_page.status_code == 200
    assert second_page.json()["next_seq"] == 2
    assert second_page.json()["has_more"] is False
    assert second_page.json()["envelopes"][0]["mailbox_seq"] == 2

    empty_page = await client.get(
        "/messages/mailbox?after_seq=2", headers=bearer(bob_token)
    )
    assert empty_page.json() == {
        "envelopes": [],
        "next_seq": 2,
        "has_more": False,
    }
    for invalid_query in ("after_seq=-1", "limit=0", "limit=101"):
        assert (
            await client.get(
                f"/messages/mailbox?{invalid_query}", headers=bearer(bob_token)
            )
        ).status_code == 422


@pytest.mark.asyncio
async def test_mailbox_read_lazily_purges_expired_payload_to_tombstone(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, _, alice_token = await create_authenticated_user(
        session_factory, "alice-tombstone"
    )
    bob, bob_devices, bob_token = await create_authenticated_user(
        session_factory, "bob-tombstone"
    )
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    client_message_id = uuid.uuid4()
    assert (
        await client.post(
            "/messages",
            headers=bearer(alice_token),
            json=send_body(
                chat.id,
                bob_devices,
                client_message_id=client_message_id,
                payloads=[b"will-expire"],
            ),
        )
    ).status_code == 201

    async with session_factory() as session:
        envelope = (await session.scalars(select(MessageEnvelope))).one()
        envelope.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        envelope_id = envelope.id
        message_id = envelope.message_id
        await session.commit()

    mailbox_response = await client.get(
        "/messages/mailbox", headers=bearer(bob_token)
    )
    assert mailbox_response.status_code == 200
    tombstone = mailbox_response.json()["envelopes"][0]
    assert tombstone["id"] == str(envelope_id)
    assert tombstone["message_id"] == str(message_id)
    assert tombstone["payload"] is None
    assert tombstone["payload_purged_at"] is not None
    assert tombstone["mailbox_seq"] == 1

    # A sender retry cannot resurrect or return an overdue payload either.
    retry = await client.post(
        "/messages",
        headers=bearer(alice_token),
        json={
            "chat_id": str(uuid.uuid4()),
            "client_message_id": str(client_message_id),
            "envelopes": [
                {
                    "recipient_device_id": str(uuid.uuid4()),
                    "protocol_version": 999,
                    "envelope_type": "INVALID",
                    "payload": "invalid",
                }
            ],
        },
    )
    assert retry.status_code == 201
    assert retry.json()["envelopes"][0]["payload"] is None

    async with session_factory() as session:
        assert await session.get(Message, message_id) is not None
        persisted = await session.get(MessageEnvelope, envelope_id)
        assert persisted is not None
        assert persisted.payload is None
        assert persisted.payload_purged_at is not None


@pytest.mark.asyncio
async def test_expiry_purge_is_batched_and_idempotent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, alice_devices, _ = await create_authenticated_user(
        session_factory, "alice-purge"
    )
    bob, bob_devices, _ = await create_authenticated_user(
        session_factory, "bob-purge"
    )
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    now = datetime.now(UTC)

    async with session_factory() as session:
        for index in range(4):
            message = Message(
                id=uuid.uuid4(),
                chat_id=chat.id,
                sender_user_id=alice.id,
                sender_device_id=alice_devices[0].id,
                client_message_id=uuid.uuid4(),
                created_at=now - timedelta(days=46),
            )
            session.add(message)
            session.add(
                MessageEnvelope(
                    id=uuid.uuid4(),
                    message_id=message.id,
                    recipient_device_id=bob_devices[0].id,
                    mailbox_seq=index + 1,
                    protocol_version=0,
                    envelope_type="PLAINTEXT",
                    payload=f"payload-{index}".encode(),
                    created_at=now - timedelta(days=46),
                    expires_at=(
                        now - timedelta(seconds=1)
                        if index < 3
                        else now + timedelta(days=1)
                    ),
                )
            )
        mailbox = await session.get(DeviceMailbox, bob_devices[0].id)
        assert mailbox is not None
        mailbox.last_seq = 4
        await session.commit()

    service = MessageService()
    async with session_factory() as session:
        assert (
            await service.purge_expired_batch(
                session, batch_size=2, now=now
            )
        ) == 2
    async with session_factory() as session:
        assert (
            await service.purge_expired_batch(
                session, batch_size=2, now=now
            )
        ) == 1
    async with session_factory() as session:
        assert (
            await service.purge_expired_batch(
                session, batch_size=2, now=now
            )
        ) == 0
        envelopes = (
            await session.scalars(
                select(MessageEnvelope).order_by(MessageEnvelope.mailbox_seq)
            )
        ).all()
        assert [item.payload is None for item in envelopes] == [
            True,
            True,
            True,
            False,
        ]
        assert all(item.payload_purged_at is not None for item in envelopes[:3])
        assert envelopes[3].payload_purged_at is None
        assert await session.scalar(select(func.count()).select_from(Message)) == 4
        assert (
            await session.scalar(select(func.count()).select_from(MessageEnvelope))
            == 4
        )


@pytest.mark.asyncio
async def test_mailbox_cannot_read_another_devices_envelopes(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, _, alice_token = await create_authenticated_user(
        session_factory, "alice-scope"
    )
    bob, bob_devices, _ = await create_authenticated_user(
        session_factory, "bob-scope", device_count=2
    )
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    response = await client.post(
        "/messages",
        headers=bearer(alice_token),
        json=send_body(chat.id, bob_devices),
    )
    assert response.status_code == 201

    second_device_auth = AuthSession(
        id=uuid.uuid4(),
        device_id=bob_devices[1].id,
        refresh_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
        refresh_cookie_bound=True,
        last_used_at=datetime.now(UTC),
        refresh_expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    async with session_factory() as session:
        session.add(second_device_auth)
        await session.commit()
    second_token = create_access_token(
        user_id=bob.id,
        device_id=bob_devices[1].id,
        session_id=second_device_auth.id,
        settings=get_settings(),
    )

    second_mailbox = await client.get(
        "/messages/mailbox", headers=bearer(second_token)
    )
    assert second_mailbox.status_code == 200
    returned = second_mailbox.json()["envelopes"]
    assert len(returned) == 1
    assert returned[0]["recipient_device_id"] == str(bob_devices[1].id)


def test_principal_contains_no_payload_or_user_supplied_sender_fields() -> None:
    fields = set(Principal.__dataclass_fields__)
    assert fields == {"user_id", "device_id", "session_id"}
