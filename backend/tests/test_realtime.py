import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from sqlalchemy import func, select

from app.auth.models import AuthSession, Device, User
from app.auth.security import JWT_ALGORITHM, create_access_token
from app.config import get_settings
from app.main import api, app
from app.messages.models import Message, MessageEnvelope
from app.messages.schemas import MAX_ENVELOPE_PAYLOAD_BYTES
from app.realtime import router as realtime_router
from app.realtime import events as realtime_events
from app.realtime.events import Connection, ConnectionRegistry, InMemoryEventBus
from test_messages import bearer, create_authenticated_user, create_direct_chat, send_body


class Socket:
    """Exercise the actual ASGI route on the same loop as the test database."""

    def __init__(self, token=None, origin=None):
        self.token = token
        self.origin = origin or str(get_settings().frontend_origin).rstrip("/")
        self.incoming = asyncio.Queue()
        self.outgoing = asyncio.Queue()

    async def __aenter__(self):
        scope = {
            "type": "websocket", "asgi": {"version": "3.0"},
            "scheme": "ws", "path": "/ws", "raw_path": b"/ws",
            "query_string": b"", "root_path": "", "http_version": "1.1",
            "headers": [(b"origin", self.origin.encode())],
            "client": ("127.0.0.1", 1234), "server": ("test", 80),
            "subprotocols": [],
        }
        self.task = asyncio.create_task(app(scope, self.incoming.get, self.outgoing.put))
        await self.incoming.put({"type": "websocket.connect"})
        self.handshake = await self.frame()
        if self.token is not None and self.handshake["type"] == "websocket.accept":
            await self.send({"type": "auth", "access_token": self.token})
        return self

    async def __aexit__(self, *args):
        await self.incoming.put({"type": "websocket.disconnect", "code": 1000})
        await asyncio.wait_for(self.task, 3)

    async def send(self, data):
        await self.incoming.put({"type": "websocket.receive", "text": json.dumps(data)})

    async def frame(self):
        return await asyncio.wait_for(self.outgoing.get(), 3)

    async def event(self):
        frame = await self.frame()
        assert frame["type"] == "websocket.send", frame
        return json.loads(frame["text"])

    async def ready(self):
        assert await self.event() == {"type": "auth.ok"}


@pytest.fixture(autouse=True)
def isolated_registry():
    registry = ConnectionRegistry()
    api.state.connection_registry = registry
    api.state.event_bus = InMemoryEventBus(registry)
    yield
    assert not registry._connections


async def test_bidirectional_delivery_http_send_and_no_ack(client, session_factory):
    alice, alice_devices, alice_token = await create_authenticated_user(session_factory, "alice-ws")
    bob, bob_devices, bob_token = await create_authenticated_user(session_factory, "bob-ws")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    async with Socket(alice_token) as alice_ws, Socket(bob_token) as bob_ws:
        await alice_ws.ready()
        await bob_ws.ready()
        request = send_body(chat.id, bob_devices, payloads=[b"opaque\x00\xff"])
        await alice_ws.send({"type": "message.send", "request_id": "first", "data": request})
        accepted = await alice_ws.event()
        incoming = await bob_ws.event()
        assert accepted["type"] == "message.accepted"
        assert accepted["request_id"] == "first"
        assert incoming["type"] == "message.new"
        assert incoming["data"]["payload"] == request["envelopes"][0]["payload"]
        assert incoming["data"]["message_id"] == accepted["data"]["id"]
        assert incoming["data"]["delivered_at"] is None
        assert incoming["data"]["payload_purged_at"] is None
        assert incoming["data"]["mailbox_seq"] == 1
        async with session_factory() as session:
            persisted = await session.get(MessageEnvelope, uuid.UUID(incoming["data"]["id"]))
            assert persisted.payload == b"opaque\x00\xff"
            assert persisted.delivered_at is None

        await bob_ws.send({"type": "message.send", "request_id": "reply", "data": send_body(chat.id, alice_devices)})
        assert (await bob_ws.event())["type"] == "message.accepted"
        assert (await alice_ws.event())["type"] == "message.new"

        # A retry returns the same metadata without creating another live event.
        await alice_ws.send({"type": "message.send", "request_id": "retry", "data": request})
        assert (await alice_ws.event())["data"]["id"] == accepted["data"]["id"]
        for event_type in ("message.delivered", "sync.request"):
            await bob_ws.send({"type": event_type, "request_id": event_type, "data": {"envelope_id": incoming["data"]["id"]}})
            error = await bob_ws.event()
            assert error["error"]["code"] == "unsupported_event"
            assert error["request_id"] == event_type
        response = await client.post("/messages", headers=bearer(alice_token), json=send_body(chat.id, bob_devices))
        assert response.status_code == 201
        assert (await bob_ws.event())["data"]["message_id"] == response.json()["id"]

    mailbox = await client.get("/messages/mailbox", headers=bearer(bob_token))
    assert len(mailbox.json()["envelopes"]) == 2
    assert all(item["payload"] is not None and item["delivered_at"] is None for item in mailbox.json()["envelopes"])


@pytest.mark.parametrize("first", [{"type": "message.send"}, {"type": "auth", "access_token": "invalid"}, [], {"type": "auth"}])
async def test_first_frame_requires_valid_auth(client, first):
    async with Socket() as socket:
        await socket.send(first)
        assert (await socket.frame())["code"] == 4401


async def test_origin_and_auth_timeout(client, monkeypatch):
    async with Socket(origin="https://untrusted.example") as socket:
        assert socket.handshake == {"type": "websocket.close", "code": 4403, "reason": ""}
    monkeypatch.setattr(realtime_router, "AUTH_TIMEOUT_SECONDS", 0.01)
    async with Socket() as socket:
        assert (await socket.frame())["code"] == 4401


async def test_malformed_events_and_authorization_errors(client, session_factory):
    alice, _, token = await create_authenticated_user(session_factory, "alice-invalid")
    bob, bob_devices, _ = await create_authenticated_user(session_factory, "bob-invalid")
    _, _, outsider_token = await create_authenticated_user(session_factory, "outsider-invalid")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    async with Socket(token) as socket:
        await socket.ready()
        for frame in ({"text": "{"}, {"text": "[]"}, {"bytes": b"binary"}):
            await socket.incoming.put({"type": "websocket.receive", **frame})
            assert (await socket.event())["error"]["code"] == "invalid_event"
        await socket.send({"type": "message.send", "request_id": "bad", "data": {}})
        assert (await socket.event())["error"]["status"] == 422
        body = send_body(chat.id, bob_devices)
        body["envelopes"][0]["payload"] = "invalid!"
        await socket.send({"type": "message.send", "request_id": "payload", "data": body})
        assert (await socket.event())["error"]["status"] == 422
        body = send_body(chat.id, bob_devices)
        body["envelopes"][0]["recipient_device_id"] = str(uuid.uuid4())
        await socket.send({"type": "message.send", "request_id": "target", "data": body})
        assert (await socket.event())["error"]["code"] == "delivery_targets_changed"
    async with Socket(outsider_token) as socket:
        await socket.ready()
        await socket.send({"type": "message.send", "request_id": "forbidden", "data": send_body(chat.id, bob_devices)})
        assert (await socket.event())["error"]["status"] == 404
    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Message)) == 0


@pytest.mark.parametrize("revocation", ["session", "device", "user", "expired_token"])
async def test_revocation_prevents_send_and_receive(client, session_factory, revocation):
    alice, _, token = await create_authenticated_user(session_factory, "alice-revoke")
    bob, bob_devices, bob_token = await create_authenticated_user(session_factory, "bob-revoke")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    async with Socket(bob_token) as bob_ws:
        await bob_ws.ready()
        async with session_factory() as session:
            if revocation == "session":
                auth = await session.scalar(select(AuthSession).where(AuthSession.device_id == bob_devices[0].id))
                auth.revoked_at = datetime.now(UTC)
            elif revocation == "device":
                device = await session.get(Device, bob_devices[0].id)
                device.revoked_at = datetime.now(UTC)
            elif revocation == "user":
                user = await session.get(User, bob.id)
                user.status = "disabled"
            await session.commit()
        if revocation == "expired_token":
            # Exercise expiry on an already authenticated socket by advancing the
            # JWT library clock, preserving the application's existing leeway.
            from unittest.mock import patch
            future = datetime.now(UTC) + timedelta(hours=1)
            with patch("jwt.api_jwt.datetime") as clock:
                clock.now.return_value = future
                await bob_ws.send({"type": "sync.request"})
                assert (await bob_ws.frame())["code"] == 4401
        else:
            await bob_ws.send({"type": "sync.request"})
            assert (await bob_ws.frame())["code"] == 4401
    async with Socket(bob_token) as socket:
        if revocation == "expired_token":
            await socket.ready()
        else:
            assert (await socket.frame())["code"] == 4401


async def test_revoked_recipient_does_not_receive_http_message(client, session_factory):
    alice, _, token = await create_authenticated_user(session_factory, "alice-live-revoke")
    bob, bob_devices, bob_token = await create_authenticated_user(session_factory, "bob-live-revoke")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    async with Socket(bob_token) as socket:
        await socket.ready()
        async with session_factory() as session:
            auth = await session.scalar(select(AuthSession).where(AuthSession.device_id == bob_devices[0].id))
            auth.revoked_at = datetime.now(UTC)
            await session.commit()
        response = await client.post("/messages", headers=bearer(token), json=send_body(chat.id, bob_devices))
        assert response.status_code == 201
        assert (await socket.frame())["code"] == 4401


async def test_reconnect_replaces_old_socket_without_losing_new_registration(client, session_factory):
    alice, _, token = await create_authenticated_user(session_factory, "alice-reconnect")
    bob, bob_devices, bob_token = await create_authenticated_user(session_factory, "bob-reconnect")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    async with Socket(bob_token) as new_socket:
        await new_socket.ready()
        async with Socket(bob_token) as replacement:
            await replacement.ready()
            assert (await new_socket.frame())["code"] == 4001
            await new_socket.incoming.put({"type": "websocket.disconnect", "code": 4001})
            await asyncio.wait_for(new_socket.task, 3)
            response = await client.post("/messages", headers=bearer(token), json=send_body(chat.id, bob_devices))
            assert response.status_code == 201
            assert (await replacement.event())["data"]["message_id"] == response.json()["id"]


async def test_expired_token_and_idle_revocation(client, session_factory, monkeypatch):
    _, devices, token = await create_authenticated_user(session_factory, "idle-revoke")
    settings = get_settings()
    claims = jwt.decode(token, settings.jwt_secret.get_secret_value(), algorithms=[JWT_ALGORITHM])
    claims["iat"] = int((datetime.now(UTC) - timedelta(hours=2)).timestamp())
    claims["exp"] = int((datetime.now(UTC) - timedelta(hours=1)).timestamp())
    expired = jwt.encode(claims, settings.jwt_secret.get_secret_value(), algorithm=JWT_ALGORITHM)
    async with Socket(expired) as socket:
        assert (await socket.frame())["code"] == 4401
    monkeypatch.setattr(realtime_router, "AUTH_CHECK_INTERVAL_SECONDS", 0.05)
    async with Socket(token) as socket:
        await socket.ready()
        async with session_factory() as session:
            auth = await session.scalar(select(AuthSession).where(AuthSession.device_id == devices[0].id))
            auth.revoked_at = datetime.now(UTC)
            await session.commit()
        assert (await socket.frame())["code"] == 4401


async def test_event_bus_failure_does_not_undo_committed_message(client, session_factory, monkeypatch):
    alice, _, token = await create_authenticated_user(session_factory, "alice-bus-failure")
    bob, devices, _ = await create_authenticated_user(session_factory, "bob-bus-failure")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)

    async def fail(*args):
        raise RuntimeError("delivery failed")

    monkeypatch.setattr(api.state.event_bus, "publish", fail)
    response = await client.post("/messages", headers=bearer(token), json=send_body(chat.id, devices))
    assert response.status_code == 201
    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Message)) == 1
        envelope = await session.scalar(select(MessageEnvelope))
        assert envelope.payload is not None
        assert envelope.delivered_at is None


async def test_blocked_old_socket_does_not_block_replacement(monkeypatch):
    monkeypatch.setattr(realtime_events, "CLOSE_TIMEOUT_SECONDS", 0.01)
    registry = ConnectionRegistry()
    device_id = uuid.uuid4()

    async def authorize():
        pass

    old = Connection(None, authorize)
    new = Connection(None, authorize)
    await registry.register(device_id, old)
    await old.lock.acquire()
    try:
        await asyncio.wait_for(registry.register(device_id, new), 0.5)
        registry.unregister(device_id, old)
        assert registry.is_current(device_id, new)
    finally:
        old.lock.release()
        registry.unregister(device_id, new)


async def test_each_online_device_receives_only_its_own_opaque_envelope(client, session_factory):
    alice, _, alice_token = await create_authenticated_user(session_factory, "alice-device-scope")
    bob, devices, first_token = await create_authenticated_user(
        session_factory, "bob-device-scope", device_count=2
    )
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    async with session_factory() as session:
        auth = AuthSession(
            id=uuid.uuid4(), device_id=devices[1].id,
            refresh_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
            refresh_cookie_bound=True, last_used_at=datetime.now(UTC),
            refresh_expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        session.add(auth)
        await session.commit()
    second_token = create_access_token(
        user_id=bob.id, device_id=devices[1].id, session_id=auth.id,
        settings=get_settings(),
    )
    request = send_body(chat.id, devices, payloads=[b"first\xff", b"second\x00"])
    async with Socket(first_token) as first, Socket(second_token) as second:
        await first.ready()
        await second.ready()
        response = await client.post("/messages", headers=bearer(alice_token), json=request)
        assert response.status_code == 201
        for index, socket in enumerate((first, second)):
            event = await socket.event()
            assert event["type"] == "message.new"
            assert event["data"]["recipient_device_id"] == str(devices[index].id)
            assert event["data"]["payload"] == request["envelopes"][index]["payload"]
            assert event["data"]["mailbox_seq"] == 1
            # A request/reply boundary detects any extra queued envelope.
            await socket.send({"type": "sync.request"})
            assert (await socket.event())["error"]["code"] == "unsupported_event"


async def test_websocket_accepts_same_large_envelope_array_as_http(client, session_factory):
    alice, _, token = await create_authenticated_user(session_factory, "alice-large-array")
    bob, devices, _ = await create_authenticated_user(
        session_factory, "bob-large-array", device_count=12
    )
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    body = send_body(
        chat.id, devices, payloads=[b"x" * MAX_ENVELOPE_PAYLOAD_BYTES] * len(devices)
    )
    async with Socket(token) as socket:
        await socket.ready()
        await socket.send({"type": "message.send", "request_id": "large", "data": body})
        event = await socket.event()
        assert event["type"] == "message.accepted"
        assert len(event["data"]["envelopes"]) == 12
