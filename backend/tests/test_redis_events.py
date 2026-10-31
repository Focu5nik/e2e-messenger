import asyncio
import json
import os
import uuid
from contextlib import AsyncExitStack
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from redis.exceptions import ConnectionError
from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import main
from app.config import Settings
from app.database import get_session
from app.auth.principal import Principal
from app.messages.models import MessageEnvelope
from app.messages.repository import MessageRepository
from app.messages.schemas import SendMessageRequest
from app.messages.service import MessageService
from app.realtime import redis_events
from app.realtime.events import Connection, ConnectionRegistry, InMemoryEventBus
from app.realtime.redis_events import RedisEventBus
from test_messages import create_authenticated_user, create_direct_chat, send_body
from test_realtime import Socket
from test_v7_migration import migrate


class Broker:
    def __init__(self):
        self.subscribers = set()
        self.created = []
        self.fail_publish = False

    def client(self, *args, **kwargs):
        client = FakeRedis(self)
        self.created.append(client)
        return client


class FakeRedis:
    def __init__(self, broker):
        self.broker = broker
        self.closed = False
        self.pubsubs = []

    def pubsub(self):
        pubsub = FakePubSub(self.broker)
        self.pubsubs.append(pubsub)
        return pubsub

    async def publish(self, channel, data):
        if self.broker.fail_publish:
            raise ConnectionError("unavailable")
        for subscriber in self.broker.subscribers:
            if subscriber.channel == channel:
                await subscriber.queue.put({"type": "message", "data": data})

    async def aclose(self):
        self.closed = True

    async def pubsub_numsub(self, channel):
        return [(channel, sum(sub.channel == channel for sub in self.broker.subscribers))]


class FakePubSub:
    def __init__(self, broker):
        self.broker = broker
        self.channel = None
        self.queue = asyncio.Queue()
        self.closed = False

    async def subscribe(self, channel):
        self.channel = channel
        self.broker.subscribers.add(self)
        await self.queue.put({"type": "subscribe"})

    async def get_message(self, **kwargs):
        message = await self.queue.get()
        if isinstance(message, Exception):
            raise message
        return message

    async def aclose(self):
        self.closed = True
        self.broker.subscribers.discard(self)


class RecordingSocket:
    def __init__(self):
        self.events = asyncio.Queue()
        self.closed = asyncio.Event()

    async def send_json(self, event):
        await self.events.put(event)

    async def close(self, code):
        self.closed.set()


async def authorized():
    pass


async def wait_until(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0.01)


@pytest.fixture(params=["fake", "redis"])
def redis_config(request, monkeypatch):
    channel = f"messenger:test:{uuid.uuid4()}"
    if request.param == "redis":
        url = os.getenv("TEST_REDIS_URL")
        if not url:
            pytest.skip("TEST_REDIS_URL is required for real Redis verification")
    else:
        url = "redis://test"
        broker = Broker()
        monkeypatch.setattr(main.Redis, "from_url", broker.client)
    config = Settings(_env_file=None, redis_url=url, redis_channel=channel)
    monkeypatch.setattr(main, "get_settings", lambda: config)
    return config


def make_application(session_factory):
    application = FastAPI(lifespan=main.lifespan)
    application.state.connection_registry = ConnectionRegistry()
    application.include_router(main.realtime_router)

    async def sessions():
        async with session_factory() as session:
            yield session

    application.dependency_overrides[get_session] = sessions
    return application


@pytest.fixture(params=["sqlite", "postgres"])
async def v8_sessions(request, session_factory):
    if request.param == "sqlite":
        yield session_factory
        return
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL is required for PostgreSQL V8 verification")
    schema = "v8_test_" + uuid.uuid4().hex
    engine = create_async_engine(url, connect_args={"server_settings": {"search_path": schema}})
    try:
        async with engine.begin() as connection:
            await connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
            await connection.run_sync(migrate, schema, "head")
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        async with engine.begin() as connection:
            await connection.exec_driver_sql(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        await engine.dispose()


async def test_two_instances_exchange_messages_delivery_and_read_events(
    v8_sessions, redis_config, monkeypatch,
):
    session_factory = v8_sessions
    alice, _, alice_token = await create_authenticated_user(session_factory, "redis-alice")
    bob, bob_devices, bob_token = await create_authenticated_user(session_factory, "redis-bob")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    first = make_application(session_factory)
    second = make_application(session_factory)
    async with AsyncExitStack() as stack:
        for application in (first, second):
            await stack.enter_async_context(application.router.lifespan_context(application))
        alice_ws = await stack.enter_async_context(Socket(alice_token, application=first))
        bob_ws = await stack.enter_async_context(Socket(bob_token, application=second))
        await alice_ws.ready()
        await bob_ws.ready()
        subscriptions = await first.state.event_bus.redis.pubsub_numsub(redis_config.redis_channel)
        assert subscriptions[0][1] == 2
        await alice_ws.send({
            "type": "message.send", "request_id": "send",
            "data": send_body(chat.id, bob_devices, payloads=[b"opaque\x00\xff"]),
        })
        accepted = await alice_ws.event()
        incoming = await bob_ws.event()
        assert accepted["type"] == "message.accepted"
        assert incoming["type"] == "message.new"
        assert incoming["data"]["message_id"] == accepted["data"]["id"]
        assert incoming["data"]["payload"] == "b3BhcXVlAP8="
        await bob_ws.send({
            "type": "message.delivered", "request_id": "ack",
            "data": {"envelope_id": incoming["data"]["id"]},
        })
        acknowledgement = await bob_ws.event()
        receipt = await alice_ws.event()
        assert acknowledgement["request_id"] == "ack"
        assert receipt["type"] == "message.delivered"
        assert receipt["data"]["payload"] is None
        assert receipt["data"]["delivered_at"] is not None
        await bob_ws.send({
            "type": "chat.read", "request_id": "read",
            "data": {"chat_id": str(chat.id), "last_read_seq": incoming["data"]["chat_seq"]},
        })
        read = await alice_ws.event()
        assert read["type"] == "chat.read.updated"
        assert read["data"]["last_read_seq"] == incoming["data"]["chat_seq"]
        own_read = [await bob_ws.event(), await bob_ws.event()]
        assert all(event["type"] == "chat.read.updated" for event in own_read)
        assert sum(event.get("request_id") == "read" for event in own_read) == 1
        # Sender instance never locally duplicates its Redis publication.
        assert alice_ws.outgoing.empty()
        assert first.state.event_bus._listener is not second.state.event_bus._listener

        async def unavailable(*args, **kwargs):
            raise ConnectionError("unavailable")

        # Publication failure cannot undo the commit; mailbox sync recovers it.
        monkeypatch.setattr(first.state.event_bus.redis, "publish", unavailable)
        await alice_ws.send({
            "type": "message.send", "request_id": "offline",
            "data": send_body(chat.id, bob_devices),
        })
        offline = await alice_ws.event()
        assert offline["type"] == "message.accepted"
        await bob_ws.send({
            "type": "sync.request", "request_id": "recover",
            "data": {"after_seq": incoming["data"]["mailbox_seq"]},
        })
        recovered = await bob_ws.event()
        assert recovered["type"] == "sync.response"
        assert recovered["data"]["envelopes"][0]["message_id"] == offline["data"]["id"]
    for application in (first, second):
        assert application.state.event_bus._listener is None
        assert not application.state.event_bus._deliveries


async def test_one_listener_routes_only_local_devices_and_rechecks_authorization():
    broker = Broker()
    registry = ConnectionRegistry()
    bus = RedisEventBus(registry, broker.client(), "test")
    device_id, revoked_id = uuid.uuid4(), uuid.uuid4()
    socket, revoked = RecordingSocket(), RecordingSocket()

    async def forbidden():
        raise RuntimeError("revoked")

    await registry.register(device_id, Connection(socket, authorized))
    await registry.register(revoked_id, Connection(revoked, forbidden))
    try:
        await bus.start()
        listener = bus._listener
        await bus.start()
        assert bus._listener is listener
        assert len(broker.subscribers) == 1
        for raw in (b"{", b"[]", b'{}', b'null', b'{"device_id":12}',
                    json.dumps({"device_id": str(device_id), "event": []})):
            await bus.redis.publish("test", raw)
        await bus.publish(uuid.uuid4(), {"type": "unrelated"})
        await bus.publish(revoked_id, {"type": "private"})
        await bus.publish(device_id, {"type": "message.new"})
        assert await asyncio.wait_for(socket.events.get(), 1) == {"type": "message.new"}
        await asyncio.wait_for(revoked.closed.wait(), 1)
        assert revoked.events.empty()
        assert socket.events.empty()
    finally:
        await bus.stop()
    assert not broker.subscribers
    assert bus.redis.closed


async def test_listener_reconnects_and_shutdown_cancels_pending_deliveries(monkeypatch):
    monkeypatch.setattr(redis_events, "RECONNECT_DELAY_SECONDS", 0.01)
    broker = Broker()
    registry = ConnectionRegistry()
    bus = RedisEventBus(registry, broker.client(), "test")
    socket = RecordingSocket()
    device_id = uuid.uuid4()
    await registry.register(device_id, Connection(socket, authorized))
    try:
        await bus.start()
        listener = bus._listener
        old_pubsub = bus._pubsub
        await old_pubsub.queue.put(ConnectionError("disconnected"))
        await wait_until(lambda: bus._pubsub is not None and bus._pubsub is not old_pubsub)
        await bus.publish(device_id, {"type": "after-reconnect"})
        assert await asyncio.wait_for(socket.events.get(), 1) == {"type": "after-reconnect"}
        assert old_pubsub.closed
        assert bus._listener is listener
        assert len(broker.subscribers) == 1

        blocked = asyncio.Event()

        async def stalled():
            blocked.set()
            await asyncio.Event().wait()

        stalled_id = uuid.uuid4()
        await registry.register(stalled_id, Connection(RecordingSocket(), stalled))
        await bus.publish(stalled_id, {"type": "stalled"})
        await asyncio.wait_for(blocked.wait(), 1)
        await bus.publish(device_id, {"type": "not-blocked"})
        assert await asyncio.wait_for(socket.events.get(), 1) == {"type": "not-blocked"}
    finally:
        await bus.stop()
    assert not bus._deliveries
    assert not broker.subscribers


async def test_lifespan_cleans_up_failed_startup(monkeypatch):
    broker = Broker()
    client = broker.client()

    async def fail_subscribe(self, channel):
        raise ConnectionError("unavailable")

    monkeypatch.setattr(FakePubSub, "subscribe", fail_subscribe)
    monkeypatch.setattr(main.Redis, "from_url", lambda *args, **kwargs: client)
    monkeypatch.setattr(main, "get_settings", lambda: Settings(_env_file=None, redis_url="redis://test"))
    application = FastAPI()
    application.state.connection_registry = ConnectionRegistry()
    with pytest.raises(ConnectionError):
        async with main.lifespan(application):
            pytest.fail("must not start without a subscription")
    assert client.closed
    assert all(pubsub.closed for pubsub in client.pubsubs)


async def test_slow_delivery_is_bounded_and_times_out(monkeypatch):
    monkeypatch.setattr(redis_events, "MAX_PENDING_DELIVERIES", 1)
    monkeypatch.setattr(redis_events, "DELIVERY_TIMEOUT_SECONDS", 0.05)
    broker = Broker()
    registry = ConnectionRegistry()
    bus = RedisEventBus(registry, broker.client(), "test")
    device_id = uuid.uuid4()
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def stalled():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    await registry.register(device_id, Connection(RecordingSocket(), stalled))
    try:
        await bus.start()
        await bus.publish(device_id, {"type": "slow"})
        await asyncio.wait_for(started.wait(), 1)
        raw = json.dumps({"device_id": str(device_id), "event": {"type": "overflow"}})
        for _ in range(10):
            bus._dispatch(raw)
        assert len(bus._deliveries) == 1
        await asyncio.wait_for(cancelled.wait(), 1)
        await wait_until(lambda: not bus._deliveries)
        socket = RecordingSocket()
        await registry.register(device_id, Connection(socket, authorized))
        await bus.publish(device_id, {"type": "recovered"})
        assert await asyncio.wait_for(socket.events.get(), 1) == {"type": "recovered"}
    finally:
        await bus.stop()


async def test_empty_url_keeps_in_memory_bus(monkeypatch):
    monkeypatch.setattr(main, "get_settings", lambda: Settings(_env_file=None, redis_url=""))
    application = FastAPI()
    application.state.connection_registry = ConnectionRegistry()
    async with main.lifespan(application):
        assert isinstance(application.state.event_bus, InMemoryEventBus)


async def test_expiry_workers_skip_locked_batches(v8_sessions):
    if v8_sessions.kw["bind"].dialect.name != "postgresql":
        pytest.skip("SKIP LOCKED requires PostgreSQL")
    alice, devices, _ = await create_authenticated_user(v8_sessions, "purge-alice")
    bob, recipients, _ = await create_authenticated_user(v8_sessions, "purge-bob")
    chat = await create_direct_chat(v8_sessions, alice.id, bob.id)
    principal = Principal(alice.id, devices[0].id, uuid.uuid4())
    service = MessageService()
    now = datetime.now(UTC)
    async with v8_sessions() as session:
        for _ in range(2):
            await service.send(
                session, principal, SendMessageRequest.model_validate(send_body(chat.id, recipients)),
            )
        await session.execute(update(MessageEnvelope).values(expires_at=now - timedelta(seconds=1)))
        await session.commit()
    repository = MessageRepository()
    async with v8_sessions() as first, v8_sessions() as second:
        locked = await repository.lock_expired_batch(first, now, 1)
        assert len(locked) == 1
        async with asyncio.timeout(3):
            assert await service.purge_expired_batch(second, now=now, batch_size=1) == 1
        assert await repository.purge_envelopes(first, locked, now) == 1
        await first.commit()
        assert await service.purge_expired_batch(second, now=now, batch_size=1) == 0
