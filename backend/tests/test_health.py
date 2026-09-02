from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

from app.database import get_session
from app.main import api, app, settings


class HealthySession:
    async def execute(self, statement: object) -> None:
        return None


class BrokenSession:
    async def execute(self, statement: object) -> None:
        raise RuntimeError("unexpected database error")


async def override_session() -> AsyncIterator[HealthySession]:
    yield HealthySession()


async def override_broken_session() -> AsyncIterator[BrokenSession]:
    yield BrokenSession()


@pytest.mark.asyncio
async def test_health_reports_database_status() -> None:
    api.dependency_overrides[get_session] = override_session
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/health")
    finally:
        api.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


@pytest.mark.asyncio
async def test_unhandled_error_includes_cors_headers() -> None:
    frontend_origin = str(settings.frontend_origin).rstrip("/")
    api.dependency_overrides[get_session] = override_broken_session
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://test",
        ) as client:
            response = await client.get("/health", headers={"Origin": frontend_origin})
    finally:
        api.dependency_overrides.clear()

    assert response.status_code == 500
    assert response.headers["access-control-allow-origin"] == frontend_origin
