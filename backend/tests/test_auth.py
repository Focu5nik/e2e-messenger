import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.auth.models import AuthSession, Device, User
from app.auth.security import (
    AccessTokenError,
    create_access_token,
    decode_access_token,
    hash_refresh_token,
    verify_password,
)
from app.config import get_settings


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


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
        json={
            "username": username,
            "password": password,
            "device_id": str(device_id),
            "device_name": device_name,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


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
    refresh_token = str(tokens["refresh_token"])
    claims = decode_access_token(access_token, get_settings())
    assert claims.device_id == device_id

    async with session_factory() as session:
        auth_session = (await session.scalars(select(AuthSession))).one()
        device = await session.get(Device, auth_session.device_id)
        assert device is not None
        assert auth_session.refresh_token_hash == hash_refresh_token(refresh_token)
        assert auth_session.refresh_token_hash != refresh_token
        assert claims.device_id == auth_session.device_id
        assert claims.user_id == device.user_id
        assert claims.session_id == auth_session.id

    me_response = await client.get("/me", headers=bearer(access_token))
    assert me_response.status_code == 200
    assert me_response.json()["username"] == "alice"
    assert me_response.json()["device_id"] == str(device_id)

    refresh_response = await client.post(
        "/auth/refresh", json={"refresh_token": refresh_token}
    )
    assert refresh_response.status_code == 200
    refreshed_tokens = refresh_response.json()
    assert refreshed_tokens["refresh_token"] == refresh_token

    repeated_refresh_response = await client.post(
        "/auth/refresh", json={"refresh_token": refresh_token}
    )
    assert repeated_refresh_response.status_code == 200

    refreshed_access_token = refreshed_tokens["access_token"]
    assert (await client.get("/me", headers=bearer(refreshed_access_token))).status_code == 200

    logout_response = await client.post(
        "/auth/logout", headers=bearer(refreshed_access_token)
    )
    assert logout_response.status_code == 204
    assert (await client.get("/me", headers=bearer(refreshed_access_token))).status_code == 401
    assert (
        await client.post(
            "/auth/refresh", json={"refresh_token": refresh_token}
        )
    ).status_code == 401


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
            "/auth/refresh", json={"refresh_token": first_tokens["refresh_token"]}
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
