import uuid

import pytest
from sqlalchemy import event, inspect
from sqlalchemy.exc import InvalidRequestError

from app.auth.principal import Principal
from app.chats.models import ChatReadState
from app.messages.responses import sent_message_response, sent_messages_response
from app.messages.service import MessageService
from test_messages import bearer, create_authenticated_user, create_direct_chat, send_body


async def test_sent_metadata_pagination_authorization_and_payload_loading(client, session_factory):
    alice, devices, token = await create_authenticated_user(session_factory, "sent-alice", device_count=2)
    bob, peers, peer_token = await create_authenticated_user(session_factory, "sent-bob")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    sent = []
    for _ in range(3):
        response = await client.post("/messages", headers=bearer(token), json=send_body(chat.id, [*peers, devices[1]]))
        assert response.status_code == 201
        sent.append(response.json())
    expected = sorted(sent, key=lambda item: uuid.UUID(item["id"]).int)
    for message in expected:
        for envelope in message["envelopes"]:
            envelope["payload"] = None

    # Another device of the same sender can recover all outgoing metadata.
    principal = Principal(alice.id, devices[1].id, uuid.uuid4())
    statements = []
    async with session_factory() as session:
        engine = session.bind.sync_engine
        def capture(connection, cursor, statement, parameters, context, executemany):
            statements.append(statement)
        event.listen(engine, "before_cursor_execute", capture)
        try:
            page = await MessageService().sent_page(session, principal, None, 2)
            assert len(statements) == 2
            assert "message_envelopes.payload " not in statements[-1]
            envelope = page.messages[0].envelopes[0]
            assert "payload" in inspect(envelope).unloaded
            with pytest.raises(InvalidRequestError, match="raiseload"):
                _ = envelope.payload
            mapped = sent_messages_response(page).model_dump(mode="json")
            assert len(statements) == 2
            assert mapped == {"messages": expected[:2], "next_message_id": expected[1]["id"], "has_more": True}
            # Even an already-loaded payload must be omitted by this mapper.
            envelope.payload = b"opaque-content"
            assert sent_message_response(page.messages[0]).envelopes[0].payload is None
        finally:
            event.remove(engine, "before_cursor_execute", capture)

    first = await client.get("/messages/sent?limit=2", headers=bearer(token))
    assert first.json() == mapped
    cursor = first.json()["next_message_id"]
    last = (await client.get(f"/messages/sent?limit=2&after_message_id={cursor}", headers=bearer(token))).json()
    assert last == {"messages": expected[2:], "next_message_id": expected[2]["id"], "has_more": False}
    cursor = last["next_message_id"]
    empty = (await client.get(f"/messages/sent?after_message_id={cursor}", headers=bearer(token))).json()
    assert empty == {"messages": [], "next_message_id": cursor, "has_more": False}
    assert (await client.get("/messages/sent", headers=bearer(peer_token))).json()["messages"] == []
    assert (await client.get("/messages/sent")).status_code == 401


async def test_unread_sent_metadata_uses_peer_cursor_and_keeps_pagination(client, session_factory):
    alice, devices, token = await create_authenticated_user(session_factory, "unread-alice", device_count=2)
    bob, peers, peer_token = await create_authenticated_user(session_factory, "unread-bob")
    carol, others, _ = await create_authenticated_user(session_factory, "unread-carol")
    chat = await create_direct_chat(session_factory, alice.id, bob.id)
    other_chat = await create_direct_chat(session_factory, alice.id, carol.id)
    sent = []
    for _ in range(4):
        response = await client.post("/messages", headers=bearer(token), json=send_body(chat.id, [*peers, devices[1]]))
        assert response.status_code == 201
        sent.append(response.json())
    other = await client.post("/messages", headers=bearer(token), json=send_body(other_chat.id, [*others, devices[1]]))
    assert other.status_code == 201
    # Delivered is still eligible until the peer reads it.
    receipt = next(item for item in sent[2]["envelopes"] if item["recipient_device_id"] == str(peers[0].id))
    assert (await client.post(f"/messages/envelopes/{receipt['id']}/ack", headers=bearer(peer_token))).status_code == 200
    async with session_factory() as session:
        session.add_all([
            ChatReadState(chat_id=chat.id, user_id=bob.id, last_read_seq=2),
            # The sender's own read cursor must not hide their outgoing messages.
            ChatReadState(chat_id=chat.id, user_id=alice.id, last_read_seq=4),
        ])
        await session.commit()

    expected = sorted([sent[2]["id"], sent[3]["id"], other.json()["id"]], key=lambda value: uuid.UUID(value).int)
    recovered = []
    after = None
    while True:
        params = {"unread_only": "true", "limit": 1}
        if after:
            params["after_message_id"] = after
        response = await client.get("/messages/sent", params=params, headers=bearer(token))
        assert response.status_code == 200
        page = response.json()
        recovered += [message["id"] for message in page["messages"]]
        assert all(envelope["payload"] is None for message in page["messages"] for envelope in message["envelopes"])
        if not page["has_more"]:
            break
        assert page["next_message_id"] != after
        after = page["next_message_id"]
    assert recovered == expected
    # Filtering applies to all sender devices and preserves authorization.
    page = await client.get("/messages/sent?unread_only=true", headers=bearer(peer_token))
    assert page.json()["messages"] == []
    async with session_factory() as session:
        page = await MessageService().sent_page(session, Principal(alice.id, devices[1].id, uuid.uuid4()), None, 100, True)
        assert [str(item.message.id) for item in page.messages] == expected
        state = await session.get(ChatReadState, (chat.id, bob.id))
        state.last_read_seq = 4
        session.add(ChatReadState(chat_id=other_chat.id, user_id=carol.id, last_read_seq=1))
        await session.commit()
    for _ in range(2):
        page = await client.get("/messages/sent?unread_only=true", headers=bearer(token))
        assert page.json() == {"messages": [], "next_message_id": None, "has_more": False}
    # The existing unfiltered API remains available for explicit full exports.
    assert len((await client.get("/messages/sent", headers=bearer(token))).json()["messages"]) == 5
