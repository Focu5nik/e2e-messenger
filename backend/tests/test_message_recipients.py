import uuid

import pytest

from app.auth.models import Device
from app.auth.principal import Principal
from app.messages.errors import EnvelopeNotFoundError
from app.messages.models import MessageEnvelope
from app.messages.service import MessageService
from test_messages import bearer, create_authenticated_user, create_direct_chat, send_body


async def test_ack_sender_copy_notifies_sender_devices_without_loading_sender_device(
    client, session_factory, monkeypatch,
):
    alice, own, token = await create_authenticated_user(session_factory, "ack-copy-a", device_count=2)
    bob, peers, _ = await create_authenticated_user(session_factory, "ack-copy-b", device_count=2)
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    response = await client.post(
        "/messages", headers=bearer(token), json=send_body(chat.id, [own[1], *peers])
    )
    assert response.status_code == 201
    envelopes = response.json()["envelopes"]
    copy_id = uuid.UUID(next(item["id"] for item in envelopes if item["recipient_device_id"] == str(own[1].id)))
    events = []

    class Bus:
        async def publish(self, device_id, event):
            events.append((device_id, event))

    service = MessageService(event_bus=Bus())
    recipient = Principal(alice.id, own[1].id, uuid.uuid4())
    receipts = []
    for _ in range(2):
        async with session_factory() as session:
            get = session.get

            async def reject_device_load(model, *args, **kwargs):
                assert model is not Device, "ACK must use the message sender_user_id directly"
                return await get(model, *args, **kwargs)

            monkeypatch.setattr(session, "get", reject_device_load)
            receipt = await service.acknowledge(session, recipient, copy_id)
            receipts.append((receipt.delivered_at, receipt.payload_purged_at))
            assert receipt.payload is None
        assert {device_id for device_id, _ in events} == {device.id for device in own}
        assert len(events) == 2
        assert all(event["data"]["recipient_user_id"] == str(alice.id) for _, event in events)
        events.clear()
    assert receipts[0] == receipts[1]
    async with session_factory() as session:
        with pytest.raises(EnvelopeNotFoundError):
            await service.acknowledge(session, Principal(bob.id, peers[0].id, uuid.uuid4()), copy_id)
    assert events == []
    async with session_factory() as session:
        for item in envelopes:
            if item["recipient_user_id"] == str(bob.id):
                retained = await session.get(MessageEnvelope, uuid.UUID(item["id"]))
                assert retained.payload is not None and retained.delivered_at is None


async def test_discovery_and_send_require_same_complete_recipient_set(client, session_factory):
    alice, own, token = await create_authenticated_user(session_factory, "targets-a", device_count=2)
    bob, peers, _ = await create_authenticated_user(session_factory, "targets-b", device_count=2)
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    expected = [own[1], *peers]
    discovered = await client.get(f"/chats/{chat.id}/destination-devices", headers=bearer(token))
    assert discovered.status_code == 200
    assert [item["id"] for item in discovered.json()] == [str(item.id) for item in sorted(expected, key=lambda item: item.id.int)]
    for wrong in (peers, [*expected, own[0]]):
        rejected = await client.post("/messages", headers=bearer(token), json=send_body(chat.id, wrong))
        assert rejected.status_code == 409
        assert rejected.json()["detail"]["code"] == "delivery_targets_changed"
    body = send_body(chat.id, expected)
    accepted = await client.post("/messages", headers=bearer(token), json=body)
    assert accepted.status_code == 201
    assert accepted.json()["chat_seq"] == 1
    assert {item["recipient_device_id"] for item in accepted.json()["envelopes"]} == {str(item.id) for item in expected}
    repeated = await client.post("/messages", headers=bearer(token), json=body)
    assert repeated.json()["id"] == accepted.json()["id"]
