import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.auth.dependencies import Principal
from app.messages.models import Message, MessageEnvelope
from app.messages.service import MessageService
from test_messages import bearer, create_authenticated_user, create_direct_chat, send_body


async def test_http_ack_is_device_scoped_idempotent_and_preserves_other_payloads(client, session_factory):
    alice, _, sender_token = await create_authenticated_user(session_factory, "alice-ack")
    bob, devices, recipient_token = await create_authenticated_user(session_factory, "bob-ack", device_count=2)
    _, _, outsider_token = await create_authenticated_user(session_factory, "outsider-ack")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    body = send_body(chat.id, devices)
    sent = (await client.post("/messages", headers=bearer(sender_token), json=body)).json()
    by_device = {item["recipient_device_id"]: item for item in sent["envelopes"]}
    first = by_device[str(devices[0].id)]
    second = by_device[str(devices[1].id)]
    endpoint = f"/messages/envelopes/{first['id']}/ack"
    assert (await client.post(endpoint)).status_code == 401
    for token in (sender_token, outsider_token):
        assert (await client.post(endpoint, headers=bearer(token))).status_code == 404
    assert (await client.post(f"/messages/envelopes/{second['id']}/ack", headers=bearer(recipient_token))).status_code == 404
    assert (await client.post(f"/messages/envelopes/{uuid.uuid4()}/ack", headers=bearer(recipient_token))).status_code == 404
    ack = await client.post(endpoint, headers=bearer(recipient_token))
    assert ack.status_code == 200
    delivered = ack.json()
    assert delivered["payload"] is None
    assert delivered["delivered_at"] == delivered["payload_purged_at"]
    assert delivered["delivered_at"] is not None
    assert {k: v for k, v in delivered.items() if k not in {"payload", "delivered_at", "payload_purged_at"}} == {
        k: v for k, v in first.items() if k not in {"payload", "delivered_at", "payload_purged_at"}
    }
    assert (await client.post(endpoint, headers=bearer(recipient_token))).json() == delivered
    lookup_path = f"/messages/by-client-id/{body['client_message_id']}"
    for token in (recipient_token, outsider_token):
        assert (await client.get(lookup_path, headers=bearer(token))).status_code == 404
    recovered = (await client.get(lookup_path, headers=bearer(sender_token))).json()
    assert recovered["id"] == sent["id"]
    assert {item["id"]: item for item in recovered["envelopes"]} == {first["id"]: delivered, second["id"]: second}
    mailbox = (await client.get("/messages/mailbox", headers=bearer(recipient_token))).json()
    assert mailbox["next_seq"] == 1
    assert mailbox["envelopes"][0]["delivered_at"] == delivered["delivered_at"]
    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Message)) == 1
        assert await session.scalar(select(func.count()).select_from(MessageEnvelope)) == 2


async def test_lookup_purges_expiry_and_late_ack_preserves_purge_timestamp(client, session_factory):
    alice, _, sender_token = await create_authenticated_user(session_factory, "alice-late-ack")
    bob, devices, recipient_token = await create_authenticated_user(session_factory, "bob-late-ack")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    body = send_body(chat.id, devices)
    sent = (await client.post("/messages", headers=bearer(sender_token), json=body)).json()
    envelope_id = sent["envelopes"][0]["id"]
    async with session_factory() as session:
        envelope = await session.get(MessageEnvelope, uuid.UUID(envelope_id))
        envelope.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
    recovered = (await client.get(f"/messages/by-client-id/{body['client_message_id']}", headers=bearer(sender_token))).json()
    expired = recovered["envelopes"][0]
    assert expired["payload"] is None
    assert expired["delivered_at"] is None
    assert expired["payload_purged_at"] is not None
    # A client that committed before expiry can retry its ACK after the purge.
    ack = (await client.post(f"/messages/envelopes/{envelope_id}/ack", headers=bearer(recipient_token))).json()
    assert ack["payload_purged_at"] == expired["payload_purged_at"]
    assert ack["delivered_at"] is not None


async def test_ack_commit_failure_rolls_back_all_fields_and_publishes_nothing(client, session_factory, monkeypatch):
    alice, _, token = await create_authenticated_user(session_factory, "alice-failed-ack")
    bob, devices, _ = await create_authenticated_user(session_factory, "bob-failed-ack")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    sent = (await client.post("/messages", headers=bearer(token), json=send_body(chat.id, devices))).json()
    envelope_id = uuid.UUID(sent["envelopes"][0]["id"])
    events = []

    class Bus:
        async def publish(self, *args):
            events.append(args)

    async def fail_commit():
        raise RuntimeError("commit failed")

    async with session_factory() as session:
        monkeypatch.setattr(session, "commit", fail_commit)
        with pytest.raises(RuntimeError, match="commit failed"):
            await MessageService(event_bus=Bus()).acknowledge(
                session, Principal(user_id=bob.id, device_id=devices[0].id, session_id=uuid.uuid4()), envelope_id
            )
        await session.rollback()
    assert events == []
    async with session_factory() as session:
        envelope = await session.get(MessageEnvelope, envelope_id)
        assert envelope.payload is not None
        assert envelope.delivered_at is None
        assert envelope.payload_purged_at is None
