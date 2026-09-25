import uuid
from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.chats.responses import read_state_response
from app.chats.types import ReadState
from app.realtime.notifications import publish_event


@pytest.mark.parametrize("updated_at", [
    None,
    datetime(2026, 1, 1),
    datetime(2026, 1, 1, 3, tzinfo=timezone(timedelta(hours=3))),
])
def test_read_response_normalizes_time_without_changing_domain_state(updated_at):
    state = ReadState(uuid.uuid4(), uuid.uuid4(), 3, updated_at)
    response = read_state_response(state)
    assert state.updated_at is updated_at
    assert response.updated_at == (
        None if updated_at is None else datetime(2026, 1, 1, tzinfo=UTC)
    )


async def test_publish_event_contains_mapping_failures():
    class Bus:
        async def publish(self, device_id, event):
            pytest.fail("invalid events must not publish")

    def invalid_event():
        raise ValueError("mapping failed")

    await publish_event(Bus(), uuid.uuid4(), invalid_event)


async def test_publish_event_keeps_bounded_best_effort_timeout(monkeypatch):
    from app.realtime import notifications

    async def timeout(awaitable, *, timeout):
        assert timeout == 5
        awaitable.close()
        raise TimeoutError

    class Bus:
        async def publish(self, device_id, event):
            pass

    monkeypatch.setattr(notifications.asyncio, "wait_for", timeout)
    await publish_event(Bus(), uuid.uuid4(), lambda: {"type": "test"})
