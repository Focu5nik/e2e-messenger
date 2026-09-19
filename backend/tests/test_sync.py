import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.auth.models import User
from app.chats.models import Chat, ChatMember
from app.messages.models import Message, MessageEnvelope
from test_messages import bearer, create_authenticated_user, create_direct_chat, send_body
from test_realtime import Socket, isolated_registry  # noqa: F401


@pytest.fixture
def sync_prefix():
    return f"v5-sync-{uuid.uuid4()}"


@pytest.fixture(params=["sqlite", "postgres"])
async def session_factory(request, session_factory, sync_prefix):
    if request.param == "sqlite":
        yield session_factory
        return
    database_url = os.getenv("TEST_DATABASE_URL")
    if database_url is None:
        pytest.skip("TEST_DATABASE_URL is required for PostgreSQL sync verification")
    engine = create_async_engine(database_url)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield factory
    finally:
        async with factory() as session:
            user_ids = select(User.id).where(User.username.startswith(sync_prefix))
            chat_ids = select(ChatMember.chat_id).where(ChatMember.user_id.in_(user_ids))
            message_ids = select(Message.id).where(Message.chat_id.in_(chat_ids))
            await session.execute(delete(MessageEnvelope).where(MessageEnvelope.message_id.in_(message_ids)))
            await session.execute(delete(Message).where(Message.chat_id.in_(chat_ids)))
            await session.execute(delete(Chat).where(Chat.id.in_(chat_ids)))
            await session.execute(delete(User).where(User.id.in_(user_ids)))
            await session.commit()
        await engine.dispose()


async def request_page(socket, after_seq=0, limit=100):
    await socket.send({
        "type": "sync.request", "request_id": f"page-{after_seq}",
        "data": {"after_seq": after_seq, "limit": limit},
    })
    event = await socket.event()
    assert event["type"] == "sync.response"
    assert event["request_id"] == f"page-{after_seq}"
    return event["data"]


async def test_offline_sync_resumes_five_then_three_and_retains_payloads(
    client, session_factory, sync_prefix,
):
    alice, _, alice_token = await create_authenticated_user(session_factory, f"{sync_prefix}-alice")
    bob, devices, bob_token = await create_authenticated_user(session_factory, f"{sync_prefix}-bob")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    received_ids = []
    cursor = 0
    for count in (5, 3):
        sent_ids = []
        for _ in range(count):
            response = await client.post("/messages", headers=bearer(alice_token), json=send_body(chat.id, devices))
            assert response.status_code == 201
            sent_ids.append(response.json()["id"])
        async with Socket(bob_token) as socket:
            await socket.ready()
            synced_ids = []
            while True:
                page = await request_page(socket, cursor, limit=2)
                # A replay is identical; reading does not acknowledge or purge.
                assert await request_page(socket, cursor, limit=2) == page
                assert [item["mailbox_seq"] for item in page["envelopes"]] == list(
                    range(cursor + 1, page["next_seq"] + 1)
                )
                synced_ids.extend(item["message_id"] for item in page["envelopes"])
                assert all(item["payload"] is not None for item in page["envelopes"])
                assert all(item["delivered_at"] is None for item in page["envelopes"])
                cursor = page["next_seq"]
                if not page["has_more"]:
                    break
            assert synced_ids == sent_ids
            received_ids.extend(synced_ids)
            assert await request_page(socket, cursor) == {
                "envelopes": [], "next_seq": cursor, "has_more": False,
            }
    assert cursor == 8
    assert len(set(received_ids)) == 8
    async with session_factory() as session:
        envelopes = (await session.scalars(select(MessageEnvelope).where(
            MessageEnvelope.recipient_device_id == devices[0].id
        ))).all()
        assert len(envelopes) == 8
        assert all(item.payload is not None and item.delivered_at is None and item.payload_purged_at is None for item in envelopes)


async def test_sync_includes_expired_tombstones_and_matches_http(
    client, session_factory, sync_prefix,
):
    alice, _, token = await create_authenticated_user(session_factory, f"{sync_prefix}-alice")
    bob, devices, bob_token = await create_authenticated_user(session_factory, f"{sync_prefix}-bob")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    for _ in range(3):
        response = await client.post("/messages", headers=bearer(token), json=send_body(chat.id, devices))
        assert response.status_code == 201
    async with session_factory() as session:
        expired = await session.scalar(select(MessageEnvelope).where(
            MessageEnvelope.recipient_device_id == devices[0].id,
            MessageEnvelope.mailbox_seq == 2,
        ))
        expired.created_at = datetime.now(UTC) - timedelta(days=46)
        expired.expires_at = datetime.now(UTC) - timedelta(days=1)
        await session.commit()
    async with Socket(bob_token) as socket:
        await socket.ready()
        first = await request_page(socket, limit=2)
        assert [item["mailbox_seq"] for item in first["envelopes"]] == [1, 2]
        assert first["envelopes"][0]["payload"] is not None
        tombstone = first["envelopes"][1]
        assert tombstone["payload"] is None
        assert tombstone["payload_purged_at"] is not None
        assert tombstone["delivered_at"] is None
        assert first["next_seq"] == 2 and first["has_more"]
        http_page = await client.get("/messages/mailbox?limit=2", headers=bearer(bob_token))
        assert http_page.json() == first
        second = await request_page(socket, first["next_seq"], limit=2)
        assert [item["mailbox_seq"] for item in second["envelopes"]] == [3]
        assert second["next_seq"] == 3 and not second["has_more"]


async def test_sync_rejects_invalid_paging_and_device_override(
    client, session_factory, sync_prefix,
):
    _, _, token = await create_authenticated_user(session_factory, f"{sync_prefix}-alice")
    async with Socket(token) as socket:
        await socket.ready()
        for data in (
            {"after_seq": -1}, {"after_seq": 2**63}, {"after_seq": True}, {"after_seq": "0"},
            {"after_seq": 1.5}, {"limit": 0}, {"limit": 101}, {"limit": False},
            {"recipient_device_id": str(uuid.uuid4())}, {"device_id": str(uuid.uuid4())},
        ):
            await socket.send({"type": "sync.request", "request_id": "invalid", "data": data})
            event = await socket.event()
            assert event["type"] == "error"
            assert event["request_id"] == "invalid"
            assert event["error"]["code"] == "invalid_event"
            assert event["error"]["status"] == 422
        await socket.send({"type": "sync.request", "request_id": "defaults", "data": {}})
        assert await socket.event() == {
            "type": "sync.response", "request_id": "defaults",
            "data": {"envelopes": [], "next_seq": 0, "has_more": False},
        }
