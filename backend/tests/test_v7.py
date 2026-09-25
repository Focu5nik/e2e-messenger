import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import func, select

from app.auth.models import AuthSession
from app.auth.principal import Principal
from app.auth.security import create_access_token
from app.chats.errors import ChatNotFoundError
from app.chats.models import ChatReadState
from app.chats.read_service import ChatReadService
from app.chats.repository import ChatRepository
from app.config import get_settings
from app.messages.models import DeviceMailbox, Message, MessageEnvelope
from app.messages.repository import MessageRepository
from test_messages import bearer, create_authenticated_user, create_device, create_direct_chat, send_body
from test_realtime import Socket, isolated_registry  # noqa: F401


async def token_for_device(factory, user_id, device_id):
    now = datetime.now(UTC)
    auth = AuthSession(
        id=uuid.uuid4(), device_id=device_id,
        refresh_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
        refresh_cookie_bound=True, last_used_at=now,
        refresh_expires_at=now + timedelta(days=1),
    )
    async with factory() as session:
        session.add(auth)
        await session.commit()
    return create_access_token(user_id=user_id, device_id=device_id, session_id=auth.id, settings=get_settings())


async def test_complete_multidevice_routing_receipts_and_all_sender_recovery(client, session_factory):
    alice, a, a1_token = await create_authenticated_user(session_factory, "v7-alice", device_count=2)
    bob, b, b1_token = await create_authenticated_user(session_factory, "v7-bob", device_count=2)
    a2_token = await token_for_device(session_factory, alice.id, a[1].id)
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    discovered = (await client.get(f"/chats/{chat.id}/destination-devices", headers=bearer(a1_token))).json()
    assert {item["id"] for item in discovered} == {str(device.id) for device in [*b, a[1]]}
    assert {item["user_id"] for item in discovered} == {str(alice.id), str(bob.id)}
    incomplete = await client.post("/messages", headers=bearer(a1_token), json=send_body(chat.id, b))
    assert incomplete.status_code == 409
    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Message)) == 0
        assert all(value == 0 for value in (await session.scalars(select(DeviceMailbox.last_seq))).all())

    async with Socket(a1_token) as a1, Socket(a2_token) as a2, Socket(b1_token) as b1:
        for socket in (a1, a2, b1):
            await socket.ready()
        body = send_body(chat.id, [*b, a[1]])
        sent_response = await client.post("/messages", headers=bearer(a1_token), json=body)
        assert sent_response.status_code == 201
        sent = sent_response.json()
        assert sent["chat_seq"] == 1
        copied = (await a2.event())["data"]
        received = (await b1.event())["data"]
        assert copied["chat_seq"] == received["chat_seq"] == 1
        assert copied["recipient_user_id"] == str(alice.id)
        assert received["recipient_user_id"] == str(bob.id)
        for token, envelope in ((a2_token, copied), (b1_token, received)):
            ack = await client.post(f"/messages/envelopes/{envelope['id']}/ack", headers=bearer(token))
            assert ack.status_code == 200
            for socket in (a1, a2):
                event = await socket.event()
                assert event["type"] == "message.delivered"
                assert event["data"]["recipient_user_id"] == envelope["recipient_user_id"]

    recovered = (await client.get("/messages/sent", headers=bearer(a2_token))).json()
    assert len(recovered["messages"]) == 1
    message = recovered["messages"][0]
    assert message["id"] == sent["id"] and message["chat_seq"] == 1
    receipts = {item["recipient_device_id"]: item for item in message["envelopes"]}
    assert receipts[str(a[1].id)]["delivered_at"] is not None
    assert receipts[str(b[0].id)]["delivered_at"] is not None
    assert receipts[str(b[1].id)]["delivered_at"] is None
    assert all(item["payload"] is None for item in receipts.values())
    assert (await client.get("/messages/sent", headers=bearer(b1_token))).json()["messages"] == []
    retry = (await client.post("/messages", headers=bearer(a1_token), json=body)).json()
    assert retry["id"] == sent["id"] and retry["chat_seq"] == 1
    async with session_factory() as session:
        retained = await session.scalar(select(MessageEnvelope).where(MessageEnvelope.recipient_device_id == b[1].id))
        assert retained.payload is not None and retained.delivered_at is None


async def test_device_added_between_discovery_and_send_requires_complete_retry(client, session_factory):
    alice, a, token = await create_authenticated_user(session_factory, "v7-change-alice")
    bob, b, _ = await create_authenticated_user(session_factory, "v7-change-bob")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    body = send_body(chat.id, b)
    async with session_factory() as session:
        a2 = await create_device(session, alice.id, "second sender")
        await session.commit()
    assert (await client.post("/messages", headers=bearer(token), json=body)).status_code == 409
    body = send_body(chat.id, [*b, a2], client_message_id=uuid.UUID(body["client_message_id"]))
    sent = (await client.post("/messages", headers=bearer(token), json=body)).json()
    assert sent["chat_seq"] == 1 and len(sent["envelopes"]) == 2
    async with session_factory() as session:
        a2_record = await session.get(type(a2), a2.id)
        a2_record.revoked_at = datetime.now(UTC)
        await session.commit()
    assert (await client.post("/messages", headers=bearer(token), json=send_body(chat.id, [*b, a2]))).status_code == 409
    assert (await client.post("/messages", headers=bearer(token), json=send_body(chat.id, b))).json()["chat_seq"] == 2


async def test_sender_copies_cannot_accept_a_message_without_any_active_peer_device(client, session_factory):
    alice, a, token = await create_authenticated_user(session_factory, "v7-no-peer-alice", device_count=2)
    bob, b, _ = await create_authenticated_user(session_factory, "v7-no-peer-bob")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    async with session_factory() as session:
        device = await session.get(type(b[0]), b[0].id)
        device.revoked_at = datetime.now(UTC)
        await session.commit()
    destinations = (await client.get(f"/chats/{chat.id}/destination-devices", headers=bearer(token))).json()
    assert [item["id"] for item in destinations] == [str(a[1].id)]
    response = await client.post("/messages", headers=bearer(token), json=send_body(chat.id, [a[1]]))
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "delivery_targets_changed"
    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Message)) == 0
        assert all(value == 0 for value in (await session.scalars(select(DeviceMailbox.last_seq))).all())


async def test_read_cursor_commit_notifications_duplicates_skipped_history_and_recovery(client, session_factory):
    alice, a, alice_token = await create_authenticated_user(session_factory, "v7-read-alice", device_count=2)
    bob, b, bob_token = await create_authenticated_user(session_factory, "v7-read-bob", device_count=2)
    a2_token = await token_for_device(session_factory, alice.id, a[1].id)
    b2_token = await token_for_device(session_factory, bob.id, b[1].id)
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    for _ in range(3):
        assert (await client.post("/messages", headers=bearer(alice_token), json=send_body(chat.id, [*b, a[1]]))).status_code == 201
    initial = (await client.get("/chats/states", headers=bearer(bob_token))).json()["states"][0]
    assert initial["last_message_seq"] == 3
    assert all(state["last_read_seq"] == 0 and state["updated_at"] is None for state in initial["read_states"])
    async with Socket(alice_token) as a1, Socket(a2_token) as a2, Socket(bob_token) as b1:
        for socket in (a1, a2, b1):
            await socket.ready()
        await b1.send({"type": "chat.read", "request_id": "read-3", "data": {"chat_id": str(chat.id), "last_read_seq": 3}})
        for socket in (a1, a2, b1):
            changed = await socket.event()
            assert changed["type"] == "chat.read.updated" and "request_id" not in changed
            assert changed["data"]["last_read_seq"] == 3
            assert changed["data"]["user_id"] == str(bob.id)
        response = await b1.event()
        assert response["request_id"] == "read-3"
        # Duplicate/lower retries return the committed state and no new broadcasts.
        for seq in (3, 1):
            await b1.send({"type": "chat.read", "request_id": "retry", "data": {"chat_id": str(chat.id), "last_read_seq": seq}})
            retry = await b1.event()
            assert retry["request_id"] == "retry" and retry["data"] == response["data"]
        assert a1.outgoing.empty() and a2.outgoing.empty() and b1.outgoing.empty()

    # An offline device recovers both cursors despite never receiving an event.
    offline = (await client.get("/chats/states", headers=bearer(b2_token))).json()["states"][0]
    assert {state["user_id"]: state["last_read_seq"] for state in offline["read_states"]} == {str(alice.id): 0, str(bob.id): 3}
    async with session_factory() as session:
        assert all(value is not None for value in (await session.scalars(select(MessageEnvelope.payload))).all())
        assert all(value is None for value in (await session.scalars(select(MessageEnvelope.delivered_at))).all())
        assert (await session.get(DeviceMailbox, b[1].id)).last_seq == 3


async def test_read_authorization_validation_and_paginated_durable_state(client, session_factory):
    alice, a, alice_token = await create_authenticated_user(session_factory, "v7-page-alice")
    bob, b, bob_token = await create_authenticated_user(session_factory, "v7-page-bob")
    eve, _, eve_token = await create_authenticated_user(session_factory, "v7-page-eve")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    other = await create_direct_chat(session_factory, alice.id, eve.id)
    for _ in range(3):
        await client.post("/messages", headers=bearer(alice_token), json=send_body(chat.id, b))
    assert (await client.get("/chats/states")).status_code == 401
    assert (await client.get("/messages/sent")).status_code == 401
    async with Socket(eve_token) as socket:
        await socket.ready()
        await socket.send({"type": "chat.read", "request_id": "foreign", "data": {"chat_id": str(chat.id), "last_read_seq": 1}})
        assert (await socket.event())["error"]["status"] == 404
    async with Socket(bob_token) as socket:
        await socket.ready()
        for seq in (-1, 4, 1.5, "1", True):
            await socket.send({"type": "chat.read", "request_id": "invalid", "data": {"chat_id": str(chat.id), "last_read_seq": seq}})
            assert (await socket.event())["error"]["status"] == 422
    states = []
    cursor = ""
    while True:
        page = (await client.get(f"/chats/states?limit=1{cursor}", headers=bearer(alice_token))).json()
        states += page["states"]
        if not page["has_more"]:
            break
        cursor = f"&after_chat_id={page['next_chat_id']}"
    assert {state["chat_id"] for state in states} == {str(chat.id), str(other.id)}
    seen = []
    cursor = ""
    while True:
        page = (await client.get(f"/messages/sent?limit=1{cursor}", headers=bearer(alice_token))).json()
        seen += [message["id"] for message in page["messages"]]
        if not page["has_more"]:
            break
        cursor = f"&after_message_id={page['next_message_id']}"
    assert len(set(seen)) == len(seen) == 3
    assert [state["chat_id"] for state in (await client.get("/chats/states", headers=bearer(bob_token))).json()["states"]] == [str(chat.id)]


async def test_read_commit_failure_never_publishes_and_retry_converges(client, session_factory, monkeypatch):
    alice, a, token = await create_authenticated_user(session_factory, "v7-fail-alice")
    bob, b, _ = await create_authenticated_user(session_factory, "v7-fail-bob")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    await client.post("/messages", headers=bearer(token), json=send_body(chat.id, b))
    events = []

    class Bus:
        async def publish(self, *args):
            events.append(args)

    async def fail_commit():
        raise RuntimeError("commit failed")

    service = ChatReadService(ChatRepository(), MessageRepository(), event_bus=Bus())
    principal = Principal(user_id=bob.id, device_id=b[0].id, session_id=uuid.uuid4())
    async with session_factory() as session:
        monkeypatch.setattr(session, "commit", fail_commit)
        with pytest.raises(RuntimeError, match="commit failed"):
            await service.advance(session, principal, chat.id, 1)
        await session.rollback()
    assert events == []
    async with session_factory() as session:
        assert await session.get(ChatReadState, (chat.id, bob.id)) is None
        saved = await service.advance(session, principal, chat.id, 1)
    assert saved.last_read_seq == 1 and len(events) == 2


async def test_read_cursor_reloads_committed_state_when_reusing_a_session(client, session_factory):
    alice, _, token = await create_authenticated_user(session_factory, "v7-stale-alice")
    bob, b, _ = await create_authenticated_user(session_factory, "v7-stale-bob")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    for _ in range(3):
        await client.post("/messages", headers=bearer(token), json=send_body(chat.id, b))
    service = ChatReadService(ChatRepository(), MessageRepository())
    principal = Principal(user_id=bob.id, device_id=b[0].id, session_id=uuid.uuid4())
    async with session_factory() as first:
        await service.advance(first, principal, chat.id, 1)
        retained = await first.get(ChatReadState, (chat.id, bob.id))
        assert retained.last_read_seq == 1
        await first.commit()
        async with session_factory() as second:
            await service.advance(second, principal, chat.id, 3)
        assert (await service.advance(first, principal, chat.id, 2)).last_read_seq == 3


async def test_foreign_read_is_rejected_before_locking(session_factory):
    alice, _, _ = await create_authenticated_user(session_factory, "v7-lock-alice")
    bob, _, _ = await create_authenticated_user(session_factory, "v7-lock-bob")
    eve, devices, _ = await create_authenticated_user(session_factory, "v7-lock-eve")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    repository = ChatRepository()
    repository.lock_chat = AsyncMock(wraps=repository.lock_chat)
    service = ChatReadService(repository, MessageRepository())
    principal = Principal(eve.id, devices[0].id, uuid.uuid4())
    async with session_factory() as session:
        with pytest.raises(ChatNotFoundError):
            await service.advance(session, principal, chat.id, 0)
        repository.lock_chat.assert_not_awaited()
        # The repository also enforces access if used directly.
        assert await repository.lock_chat(session, eve.id, chat.id) is None


async def test_read_publication_failure_preserves_http_recovery(client, session_factory):
    alice, _, token = await create_authenticated_user(session_factory, "v7-publish-alice")
    bob, devices, bob_token = await create_authenticated_user(session_factory, "v7-publish-bob")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    await client.post("/messages", headers=bearer(token), json=send_body(chat.id, devices))
    attempted = []

    class FailingBus:
        async def publish(self, device_id, event):
            attempted.append(device_id)
            raise RuntimeError("publication failed")

    service = ChatReadService(ChatRepository(), MessageRepository(), FailingBus())
    principal = Principal(bob.id, devices[0].id, uuid.uuid4())
    async with session_factory() as session:
        saved = await service.advance(session, principal, chat.id, 1)
    assert saved.last_read_seq == 1
    assert len(attempted) == 2
    recovered = (await client.get("/chats/states", headers=bearer(bob_token))).json()
    state = next(
        state for state in recovered["states"][0]["read_states"]
        if state["user_id"] == str(bob.id)
    )
    assert state["last_read_seq"] == 1
    assert state["updated_at"] is not None
