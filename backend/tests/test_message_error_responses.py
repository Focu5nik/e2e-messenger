import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.auth.principal import Principal
from app.chats.errors import ChatNotFoundError
from app.messages.errors import (
    DeliveryTargetsChangedError,
    DuplicateDestinationError,
    EnvelopeNotFoundError,
    InvalidEnvelopeError,
)
from app.messages.router import acknowledge_delivery, destination_devices, send_message
from app.messages.schemas import ClientEnvelopeRequest, SendMessageRequest
from app.realtime.handlers import handle_delivery, handle_send


@pytest.fixture
def principal():
    return Principal(uuid.uuid4(), uuid.uuid4(), uuid.uuid4())


@pytest.mark.parametrize(
    ("error", "status", "code", "message"),
    [
        (ChatNotFoundError(), 404, "message_rejected", "chat not found"),
        (
            DuplicateDestinationError(), 422, "message_rejected",
            "duplicate recipient device",
        ),
        (InvalidEnvelopeError("invalid payload"), 422, "message_rejected", "invalid payload"),
        (
            DeliveryTargetsChangedError(), 409, "delivery_targets_changed",
            "Destination devices changed; refresh and retry.",
        ),
    ],
)
async def test_send_errors_preserve_http_and_websocket_contracts(
    principal, error, status, code, message
):
    service = AsyncMock()
    service.send.side_effect = error
    request = SendMessageRequest(
        chat_id=uuid.uuid4(),
        client_message_id=uuid.uuid4(),
        envelopes=[ClientEnvelopeRequest(
            recipient_device_id=uuid.uuid4(), protocol_version=0,
            envelope_type="PLAINTEXT", payload="aGVsbG8=",
        )],
    )

    with pytest.raises(HTTPException) as result:
        await send_message(request, principal, AsyncMock(), service)
    assert result.value.status_code == status
    assert result.value.detail == (
        {"code": code, "message": message} if status == 409 else message
    )

    response = await handle_send(
        {"type": "message.send", "request_id": "send-1", "data": request.model_dump(mode="json")},
        AsyncMock(), principal, service,
    )
    assert response == {
        "type": "error", "request_id": "send-1",
        "error": {"code": code, "message": message, "status": status},
    }


async def test_missing_envelope_preserves_http_and_websocket_contracts(principal):
    service = AsyncMock()
    service.acknowledge.side_effect = EnvelopeNotFoundError()
    envelope_id = uuid.uuid4()

    with pytest.raises(HTTPException) as result:
        await acknowledge_delivery(envelope_id, principal, AsyncMock(), service)
    assert result.value.status_code == 404
    assert result.value.detail == "envelope not found"

    response = await handle_delivery(
        {
            "type": "message.delivered", "request_id": "delivery-1",
            "data": {"envelope_id": str(envelope_id)},
        },
        AsyncMock(), principal, service,
    )
    assert response == {
        "type": "error", "request_id": "delivery-1",
        "error": {"code": "envelope_not_found", "message": "envelope not found", "status": 404},
    }


async def test_missing_destination_chat_preserves_http_contract(principal):
    service = AsyncMock()
    service.destination_devices.side_effect = ChatNotFoundError()
    with pytest.raises(HTTPException) as result:
        await destination_devices(uuid.uuid4(), principal, AsyncMock(), service)
    assert result.value.status_code == 404
    assert result.value.detail == "chat not found"
