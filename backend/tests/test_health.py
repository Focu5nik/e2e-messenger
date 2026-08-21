from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

from app.database import get_session
from app.main import app


class HealthySession:
    async def execute(self, statement: object) -> None:
        return None


async def override_session() -> AsyncIterator[HealthySession]:
    yield HealthySession()


@pytest.mark.asyncio
async def test_health_reports_database_status() -> None:
    app.dependency_overrides[get_session] = override_session
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/health")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}

