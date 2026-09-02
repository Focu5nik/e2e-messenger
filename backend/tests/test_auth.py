import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.auth.models import AuthSession, Device, RefreshTokenHistory, User
from app.auth.router import REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH
from app.auth.security import (
    AccessTokenError,
    create_access_token,
    decode_access_token,
    hash_refresh_token,
    verify_password,
)
from app.config import Settings, get_settings


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def trusted_origin_headers() -> dict[str, str]:
    return {"Origin": str(get_settings().frontend_origin).rstrip("/")}


def refresh_cookie(client: AsyncClient) -> str:
    value = client.cookies.get(REFRESH_COOKIE_NAME)
    assert value is not None
    return value


def refresh_cookie_headers(token: str) -> dict[str, str]:
    return {
        **trusted_origin_headers(),
        "Cookie": f"{REFRESH_COOKIE_NAME}={token}",
    }


def assert_refresh_cookie_set(response) -> None:
    header = response.headers["set-cookie"].lower()
    assert f"{REFRESH_COOKIE_NAME}=" in header
    assert f"path={REFRESH_COOKIE_PATH}" in header
    assert "max-age=" in header
    assert "expires=" in header
    assert "secure" in header
    assert "httponly" in header
    assert "samesite=strict" in header
    assert "domain=" not in header


def assert_refresh_cookie_cleared(response) -> None:
    header = response.headers["set-cookie"].lower()
    assert f"{REFRESH_COOKIE_NAME}=\"\"" in header
    assert f"path={REFRESH_COOKIE_PATH}" in header
    assert "max-age=0" in header
    assert "secure" in header
    assert "httponly" in header
    assert "samesite=strict" in header
    assert "domain=" not in header


async def register(client: AsyncClient, username: str, password: str = "correct horse") -> None:
    response = await client.post(
        "/auth/register", json={"username": username, "password": password}
    )
    assert response.status_code == 201, response.text


async def login(
    client: AsyncClient,
    username: str,
    device_id: uuid.UUID,
    *,
    password: str = "correct horse",
    device_name: str = "Test browser",
) -> dict[str, object]:
    response = await client.post(
        "/auth/login",
        headers=trusted_origin_headers(),
        json={
            "username": username,
            "password": password,
            "device_id": str(device_id),
            "device_name": device_name,
        },
    )
    assert response.status_code == 200, response.text
    assert_refresh_cookie_set(response)
    payload = response.json()
    assert set(payload) == {"access_token", "token_type", "expires_in"}
    return payload


@pytest.mark.asyncio
async def test_register_login_refresh_me_and_logout(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    device_id = uuid.uuid4()
    await register(client, "Alice")

    async with session_factory() as session:
        user = (await session.scalars(select(User))).one()
        assert user.username == "alice"
        assert user.password_hash != "correct horse"
        assert verify_password("correct horse", user.password_hash)

    tokens = await login(client, "ALICE", device_id)
    access_token = str(tokens["access_token"])
    initial_refresh_token = refresh_cookie(client)
    claims = decode_access_token(access_token, get_settings())
    assert claims.device_id == device_id

    async with session_factory() as session:
        auth_session = (await session.scalars(select(AuthSession))).one()
        device = await session.get(Device, auth_session.device_id)
        assert device is not None
        assert auth_session.refresh_token_hash == hash_refresh_token(
            initial_refresh_token
        )
        assert auth_session.refresh_cookie_bound
        assert auth_session.refresh_token_hash != initial_refresh_token
        assert claims.device_id == auth_session.device_id
        assert claims.user_id == device.user_id
        assert claims.session_id == auth_session.id

    me_response = await client.get("/me", headers=bearer(access_token))
    assert me_response.status_code == 200
    assert me_response.json()["username"] == "alice"
    assert me_response.json()["device_id"] == str(device_id)

    refresh_response = await client.post(
        "/auth/refresh", headers=trusted_origin_headers()
    )
    assert refresh_response.status_code == 200
    assert_refresh_cookie_set(refresh_response)
    refreshed_tokens = refresh_response.json()
    assert "refresh_token" not in refreshed_tokens
    rotated_refresh_token = refresh_cookie(client)
    assert rotated_refresh_token != initial_refresh_token

    repeated_refresh_response = await client.post(
        "/auth/refresh", headers=trusted_origin_headers()
    )
    assert repeated_refresh_response.status_code == 200
    twice_rotated_refresh_token = refresh_cookie(client)
    assert twice_rotated_refresh_token not in {
        initial_refresh_token,
        rotated_refresh_token,
    }

    async with session_factory() as session:
        auth_session = (await session.scalars(select(AuthSession))).one()
        history = (await session.scalars(select(RefreshTokenHistory))).all()
        assert auth_session.refresh_token_hash == hash_refresh_token(
            twice_rotated_refresh_token
        )
        assert {item.token_hash for item in history} == {
            hash_refresh_token(initial_refresh_token),
            hash_refresh_token(rotated_refresh_token),
        }

    refreshed_access_token = repeated_refresh_response.json()["access_token"]
    assert (await client.get("/me", headers=bearer(refreshed_access_token))).status_code == 200

    logout_response = await client.post(
        "/auth/logout", headers=trusted_origin_headers()
    )
    assert logout_response.status_code == 204
    assert_refresh_cookie_cleared(logout_response)
    assert (await client.get("/me", headers=bearer(refreshed_access_token))).status_code == 401
    assert (
        await client.post(
            "/auth/refresh",
            headers=refresh_cookie_headers(twice_rotated_refresh_token),
        )
    ).status_code == 401


@pytest.mark.asyncio
async def test_reusing_any_rotated_refresh_token_revokes_the_family(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await register(client, "alice")
    tokens = await login(client, "alice", uuid.uuid4())
    first_refresh_token = refresh_cookie(client)

    first_refresh = await client.post(
        "/auth/refresh", headers=trusted_origin_headers()
    )
    assert first_refresh.status_code == 200
    second_refresh_token = refresh_cookie(client)

    second_refresh = await client.post(
        "/auth/refresh", headers=trusted_origin_headers()
    )
    assert second_refresh.status_code == 200
    current_refresh_token = refresh_cookie(client)
    current_access_token = second_refresh.json()["access_token"]

    reuse_response = await client.post(
        "/auth/refresh",
        headers=refresh_cookie_headers(first_refresh_token),
    )
    assert reuse_response.status_code == 401
    assert reuse_response.json() == {"detail": "invalid or expired refresh token"}
    assert_refresh_cookie_cleared(reuse_response)

    async with session_factory() as session:
        auth_session = (await session.scalars(select(AuthSession))).one()
        history = (await session.scalars(select(RefreshTokenHistory))).all()
        assert auth_session.revoked_at is not None
        assert auth_session.refresh_token_hash == hash_refresh_token(
            current_refresh_token
        )
        assert {item.token_hash for item in history} == {
            hash_refresh_token(first_refresh_token),
            hash_refresh_token(second_refresh_token),
        }

    assert (
        await client.get("/me", headers=bearer(current_access_token))
    ).status_code == 401
    assert (
        await client.post(
            "/auth/refresh",
            headers=refresh_cookie_headers(current_refresh_token),
        )
    ).status_code == 401
    assert (
        await client.get("/me", headers=bearer(str(tokens["access_token"])))
    ).status_code == 401


@pytest.mark.asyncio
async def test_refresh_failures_and_reuse_are_scoped_to_the_matching_family(
    client: AsyncClient,
) -> None:
    await register(client, "alice")

    await login(client, "alice", uuid.uuid4(), device_name="Laptop")
    first_refresh_token = refresh_cookie(client)
    first_refresh_response = await client.post(
        "/auth/refresh", headers=trusted_origin_headers()
    )
    assert first_refresh_response.status_code == 200

    second_tokens = await login(client, "alice", uuid.uuid4(), device_name="Phone")
    second_refresh_token = refresh_cookie(client)
    unknown_refresh_token = "x" * 64

    unknown_refresh_response = await client.post(
        "/auth/refresh",
        headers=refresh_cookie_headers(unknown_refresh_token),
    )
    assert unknown_refresh_response.status_code == 401
    unknown_logout_response = await client.post(
        "/auth/logout",
        headers=refresh_cookie_headers(unknown_refresh_token),
    )
    assert unknown_logout_response.status_code == 204

    for access_token in (
        first_refresh_response.json()["access_token"],
        second_tokens["access_token"],
    ):
        assert (
            await client.get("/me", headers=bearer(str(access_token)))
        ).status_code == 200

    reuse_response = await client.post(
        "/auth/refresh",
        headers=refresh_cookie_headers(first_refresh_token),
    )
    assert reuse_response.status_code == 401
    assert (
        await client.get(
            "/me",
            headers=bearer(str(first_refresh_response.json()["access_token"])),
        )
    ).status_code == 401
    assert (
        await client.get(
            "/me", headers=bearer(str(second_tokens["access_token"]))
        )
    ).status_code == 200

    unrelated_refresh_response = await client.post(
        "/auth/refresh",
        headers=refresh_cookie_headers(second_refresh_token),
    )
    assert unrelated_refresh_response.status_code == 200
    assert (
        await client.get(
            "/me",
            headers=bearer(str(unrelated_refresh_response.json()["access_token"])),
        )
    ).status_code == 200


@pytest.mark.asyncio
async def test_cookie_auth_endpoints_require_one_exact_origin(
    client: AsyncClient,
) -> None:
    await register(client, "alice")
    login_body = {
        "username": "alice",
        "password": "correct horse",
        "device_id": str(uuid.uuid4()),
        "device_name": "Test browser",
    }
    expected_origin = trusted_origin_headers()["Origin"]

    for headers in (
        None,
        {"Origin": "null"},
        {"Origin": f"{expected_origin}.example"},
    ):
        response = await client.post("/auth/login", headers=headers, json=login_body)
        assert response.status_code == 403
        assert "set-cookie" not in response.headers

    duplicate_origin_response = await client.post(
        "/auth/login",
        headers=[("Origin", expected_origin), ("Origin", expected_origin)],
        json=login_body,
    )
    assert duplicate_origin_response.status_code == 403
    assert "set-cookie" not in duplicate_origin_response.headers

    tokens = await login(client, "alice", uuid.UUID(login_body["device_id"]))
    access_token = str(tokens["access_token"])
    original_refresh_token = refresh_cookie(client)

    for path in ("/auth/refresh", "/auth/logout"):
        for headers in (
            None,
            {"Origin": "null"},
            {"Origin": f"{expected_origin}/unexpected"},
        ):
            response = await client.post(path, headers=headers)
            assert response.status_code == 403
            assert "set-cookie" not in response.headers

    assert refresh_cookie(client) == original_refresh_token
    assert (await client.get("/me", headers=bearer(access_token))).status_code == 200

    refresh_response = await client.post(
        "/auth/refresh", headers=trusted_origin_headers()
    )
    assert refresh_response.status_code == 200
    assert refresh_cookie(client) != original_refresh_token

    logout_response = await client.post(
        "/auth/logout", headers=trusted_origin_headers()
    )
    assert logout_response.status_code == 204
    assert_refresh_cookie_cleared(logout_response)


@pytest.mark.asyncio
async def test_access_token_claims_must_match_session_device_owner(
    client: AsyncClient,
) -> None:
    device_id = uuid.uuid4()
    await register(client, "alice")
    tokens = await login(client, "alice", device_id)
    claims = decode_access_token(str(tokens["access_token"]), get_settings())

    forged_tokens = (
        create_access_token(
            user_id=uuid.uuid4(),
            device_id=claims.device_id,
            session_id=claims.session_id,
            settings=get_settings(),
        ),
        create_access_token(
            user_id=claims.user_id,
            device_id=uuid.uuid4(),
            session_id=claims.session_id,
            settings=get_settings(),
        ),
    )

    for forged_token in forged_tokens:
        assert (await client.get("/me", headers=bearer(forged_token))).status_code == 401


@pytest.mark.asyncio
async def test_device_identifier_cannot_change_owners(client: AsyncClient) -> None:
    device_id = uuid.uuid4()
    await register(client, "alice")
    await register(client, "bob")
    alice_tokens = await login(client, "alice", device_id)

    response = await client.post(
        "/auth/login",
        headers=trusted_origin_headers(),
        json={
            "username": "bob",
            "password": "correct horse",
            "device_id": str(device_id),
            "device_name": "Bob's browser",
        },
    )

    assert response.status_code == 409
    assert (
        await client.get("/me", headers=bearer(str(alice_tokens["access_token"])))
    ).status_code == 200


@pytest.mark.asyncio
async def test_device_revocation_ends_all_device_sessions(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    first_device_id = uuid.uuid4()
    second_device_id = uuid.uuid4()
    await register(client, "alice")
    first_tokens = await login(client, "alice", first_device_id, device_name="Laptop")
    first_refresh_token = refresh_cookie(client)
    second_tokens = await login(client, "alice", second_device_id, device_name="Phone")

    devices_response = await client.get(
        "/devices", headers=bearer(str(second_tokens["access_token"]))
    )
    assert devices_response.status_code == 200
    assert {device["id"] for device in devices_response.json()} == {
        str(first_device_id),
        str(second_device_id),
    }

    revoke_response = await client.delete(
        f"/devices/{first_device_id}",
        headers=bearer(str(second_tokens["access_token"])),
    )
    assert revoke_response.status_code == 204
    assert (
        await client.get("/me", headers=bearer(str(first_tokens["access_token"])))
    ).status_code == 401
    assert (
        await client.post(
            "/auth/refresh",
            headers=refresh_cookie_headers(first_refresh_token),
        )
    ).status_code == 401

    async with session_factory() as session:
        revoked_device = await session.get(Device, first_device_id)
        assert revoked_device is not None and revoked_device.revoked_at is not None
        revoked_sessions = (
            await session.scalars(
                select(AuthSession).where(AuthSession.device_id == first_device_id)
            )
        ).all()
        assert revoked_sessions
        assert all(item.revoked_at is not None for item in revoked_sessions)

    revoked_login_response = await client.post(
        "/auth/login",
        headers=trusted_origin_headers(),
        json={
            "username": "alice",
            "password": "correct horse",
            "device_id": str(first_device_id),
            "device_name": "Laptop",
        },
    )
    assert revoked_login_response.status_code == 403
    assert revoked_login_response.json() == {"detail": "device is revoked"}

    replacement_device_id = uuid.uuid4()
    replacement_tokens = await login(
        client,
        "alice",
        replacement_device_id,
        device_name="Laptop",
    )
    replacement_claims = decode_access_token(
        str(replacement_tokens["access_token"]), get_settings()
    )
    assert replacement_claims.device_id == replacement_device_id

    replacement_devices_response = await client.get(
        "/devices", headers=bearer(str(replacement_tokens["access_token"]))
    )
    assert replacement_devices_response.status_code == 200
    replacement_devices = {
        device["id"]: device for device in replacement_devices_response.json()
    }
    assert replacement_devices[str(first_device_id)]["revoked_at"] is not None
    assert replacement_devices[str(replacement_device_id)]["revoked_at"] is None


@pytest.mark.asyncio
async def test_cannot_revoke_another_users_device(client: AsyncClient) -> None:
    alice_device_id = uuid.uuid4()
    bob_device_id = uuid.uuid4()
    await register(client, "alice")
    await register(client, "bob")
    alice_tokens = await login(client, "alice", alice_device_id)
    bob_tokens = await login(client, "bob", bob_device_id)

    response = await client.delete(
        f"/devices/{bob_device_id}",
        headers=bearer(str(alice_tokens["access_token"])),
    )
    assert response.status_code == 404
    assert (
        await client.get("/me", headers=bearer(str(bob_tokens["access_token"])))
    ).status_code == 200


@pytest.mark.asyncio
async def test_inactive_user_and_revoked_session_reject_existing_access_token(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await register(client, "alice")
    tokens = await login(client, "alice", uuid.uuid4())

    async with session_factory() as session:
        user = (await session.scalars(select(User))).one()
        user.status = "disabled"
        await session.commit()

    assert (
        await client.get("/me", headers=bearer(str(tokens["access_token"])))
    ).status_code == 401


@pytest.mark.asyncio
async def test_pre_cookie_session_is_rejected_by_access_and_refresh(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await register(client, "alice")
    tokens = await login(client, "alice", uuid.uuid4())
    legacy_refresh_token = refresh_cookie(client)

    async with session_factory() as session:
        auth_session = (await session.scalars(select(AuthSession))).one()
        auth_session.refresh_cookie_bound = False
        await session.commit()

    assert (
        await client.get("/me", headers=bearer(str(tokens["access_token"])))
    ).status_code == 401
    refresh_response = await client.post(
        "/auth/refresh",
        headers=refresh_cookie_headers(legacy_refresh_token),
    )
    assert refresh_response.status_code == 401
    assert_refresh_cookie_cleared(refresh_response)


def test_access_token_claims_are_required_and_strictly_typed() -> None:
    settings = get_settings()
    now = datetime.now(UTC)
    base_claims = {
        "sub": str(uuid.uuid4()),
        "sid": str(uuid.uuid4()),
        "did": str(uuid.uuid4()),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=1)).timestamp()),
    }

    for invalid_claims in (
        {key: value for key, value in base_claims.items() if key != "did"},
        {**base_claims, "iat": str(base_claims["iat"])},
        {**base_claims, "exp": base_claims["iat"]},
    ):
        token = jwt.encode(
            invalid_claims,
            settings.jwt_secret.get_secret_value(),
            algorithm="HS256",
        )
        with pytest.raises(AccessTokenError):
            decode_access_token(token, settings)


@pytest.mark.parametrize(
    "origin",
    (
        "https://user@example.com",
        "https://example.com/app",
        "https://example.com?mode=test",
        "https://example.com#fragment",
    ),
)
def test_frontend_origin_configuration_must_be_origin_only(origin: str) -> None:
    with pytest.raises(ValidationError):
        Settings(
            frontend_origin=origin,
            jwt_secret="test-only-secret-that-is-at-least-32-characters",
            _env_file=None,
        )
