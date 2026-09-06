import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.auth.models import AuthSession, Device, User
from app.auth.security import create_access_token
from app.chats.models import Chat, ChatMember, DirectChatPair
from app.config import get_settings


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def create_authenticated_user(
    session_factory: async_sessionmaker[AsyncSession],
    username: str,
    *,
    user_id: uuid.UUID | None = None,
    user_status: str = "active",
) -> tuple[User, str]:
    resolved_user_id = user_id or uuid.uuid4()
    device_id = uuid.uuid4()
    auth_session_id = uuid.uuid4()
    now = datetime.now(UTC)
    user = User(
        id=resolved_user_id,
        username=username,
        password_hash="not-used-by-chat-tests",
        status=user_status,
    )
    async with session_factory() as session:
        session.add_all(
            [
                user,
                Device(
                    id=device_id,
                    user_id=resolved_user_id,
                    name=f"{username} test device",
                    last_seen_at=now,
                ),
                AuthSession(
                    id=auth_session_id,
                    device_id=device_id,
                    refresh_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
                    refresh_cookie_bound=True,
                    last_used_at=now,
                    refresh_expires_at=now + timedelta(days=1),
                ),
            ]
        )
        await session.commit()
        await session.refresh(user)

    token = create_access_token(
        user_id=resolved_user_id,
        device_id=device_id,
        session_id=auth_session_id,
        settings=get_settings(),
    )
    return user, token


@pytest.mark.asyncio
async def test_user_search_is_authenticated_active_case_insensitive_and_excludes_self(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, alice_token = await create_authenticated_user(session_factory, "alice")
    bob, _ = await create_authenticated_user(session_factory, "bob")
    bobby, _ = await create_authenticated_user(session_factory, "bobby")
    await create_authenticated_user(
        session_factory, "bob-disabled", user_status="disabled"
    )
    charlie, _ = await create_authenticated_user(session_factory, "charlie")

    assert (await client.get("/users?search=bo")).status_code == 401

    response = await client.get(
        "/users?search=BO", headers=bearer(alice_token)
    )
    assert response.status_code == 200
    assert response.json() == [
        {
            "id": str(bob.id),
            "username": "bob",
            "status": "active",
            "created_at": bob.created_at.isoformat().replace("+00:00", "Z"),
        },
        {
            "id": str(bobby.id),
            "username": "bobby",
            "status": "active",
            "created_at": bobby.created_at.isoformat().replace("+00:00", "Z"),
        },
    ]

    all_users_response = await client.get(
        "/users", headers=bearer(alice_token)
    )
    assert all_users_response.status_code == 200
    assert {item["id"] for item in all_users_response.json()} == {
        str(bob.id),
        str(bobby.id),
        str(charlie.id),
    }
    assert str(alice.id) not in {
        item["id"] for item in all_users_response.json()
    }


@pytest.mark.asyncio
async def test_open_direct_chat_is_canonical_and_idempotent_in_either_order(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    high_id = uuid.UUID("ffffffff-ffff-ffff-ffff-ffffffffffff")
    low_id = uuid.UUID("00000000-0000-0000-0000-000000000001")
    alice, alice_token = await create_authenticated_user(
        session_factory, "alice", user_id=high_id
    )
    bob, bob_token = await create_authenticated_user(
        session_factory, "bob", user_id=low_id
    )

    first_response = await client.post(
        f"/chats/direct/{bob.id}", headers=bearer(alice_token)
    )
    repeated_response = await client.post(
        f"/chats/direct/{bob.id}", headers=bearer(alice_token)
    )
    reverse_response = await client.post(
        f"/chats/direct/{alice.id}", headers=bearer(bob_token)
    )

    assert first_response.status_code == 200
    assert repeated_response.status_code == 200
    assert reverse_response.status_code == 200
    first_payload = first_response.json()
    assert set(first_payload) == {"id", "type", "created_at", "other_user"}
    assert first_payload["type"] == "DIRECT"
    assert first_payload["other_user"]["id"] == str(bob.id)
    assert repeated_response.json() == first_payload
    assert reverse_response.json()["id"] == first_payload["id"]
    assert reverse_response.json()["other_user"]["id"] == str(alice.id)

    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Chat)) == 1
        assert (
            await session.scalar(select(func.count()).select_from(DirectChatPair))
            == 1
        )
        assert (
            await session.scalar(select(func.count()).select_from(ChatMember)) == 2
        )
        pair = (await session.scalars(select(DirectChatPair))).one()
        members = set(
            (
                await session.scalars(
                    select(ChatMember.user_id).where(
                        ChatMember.chat_id == pair.chat_id
                    )
                )
            ).all()
        )
        assert (pair.user_low_id, pair.user_high_id) == (low_id, high_id)
        assert members == {low_id, high_id}


@pytest.mark.asyncio
async def test_open_direct_chat_rejects_self_missing_and_inactive_targets_without_rows(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, alice_token = await create_authenticated_user(session_factory, "alice")
    inactive, _ = await create_authenticated_user(
        session_factory, "inactive", user_status="disabled"
    )

    self_response = await client.post(
        f"/chats/direct/{alice.id}", headers=bearer(alice_token)
    )
    missing_response = await client.post(
        f"/chats/direct/{uuid.uuid4()}", headers=bearer(alice_token)
    )
    inactive_response = await client.post(
        f"/chats/direct/{inactive.id}", headers=bearer(alice_token)
    )

    assert self_response.status_code == 400
    assert missing_response.status_code == 404
    assert inactive_response.status_code == 404
    async with session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Chat)) == 0
        assert (
            await session.scalar(select(func.count()).select_from(DirectChatPair))
            == 0
        )
        assert (
            await session.scalar(select(func.count()).select_from(ChatMember)) == 0
        )


@pytest.mark.asyncio
async def test_list_and_detail_are_scoped_to_members_and_return_the_other_user(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, alice_token = await create_authenticated_user(session_factory, "alice")
    bob, bob_token = await create_authenticated_user(session_factory, "bob")
    charlie, charlie_token = await create_authenticated_user(
        session_factory, "charlie"
    )
    outsider, outsider_token = await create_authenticated_user(
        session_factory, "outsider"
    )

    bob_chat = (
        await client.post(
            f"/chats/direct/{bob.id}", headers=bearer(alice_token)
        )
    ).json()
    charlie_chat = (
        await client.post(
            f"/chats/direct/{charlie.id}", headers=bearer(alice_token)
        )
    ).json()

    alice_list = await client.get("/chats", headers=bearer(alice_token))
    bob_list = await client.get("/chats", headers=bearer(bob_token))
    outsider_list = await client.get("/chats", headers=bearer(outsider_token))
    assert alice_list.status_code == 200
    assert {item["id"] for item in alice_list.json()} == {
        bob_chat["id"],
        charlie_chat["id"],
    }
    assert {item["other_user"]["id"] for item in alice_list.json()} == {
        str(bob.id),
        str(charlie.id),
    }
    assert [item["id"] for item in bob_list.json()] == [bob_chat["id"]]
    assert bob_list.json()[0]["other_user"]["id"] == str(alice.id)
    assert outsider_list.json() == []

    charlie_detail = await client.get(
        f"/chats/{charlie_chat['id']}", headers=bearer(charlie_token)
    )
    outsider_detail = await client.get(
        f"/chats/{charlie_chat['id']}", headers=bearer(outsider_token)
    )
    missing_detail = await client.get(
        f"/chats/{uuid.uuid4()}", headers=bearer(alice_token)
    )
    assert charlie_detail.status_code == 200
    assert charlie_detail.json()["other_user"]["id"] == str(alice.id)
    assert outsider_detail.status_code == 404
    assert missing_detail.status_code == 404


@pytest.mark.asyncio
async def test_direct_chat_pair_memberships_cannot_be_deleted(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice, alice_token = await create_authenticated_user(session_factory, "alice")
    bob, _ = await create_authenticated_user(session_factory, "bob")
    chat_payload = (
        await client.post(
            f"/chats/direct/{bob.id}", headers=bearer(alice_token)
        )
    ).json()
    chat_id = uuid.UUID(chat_payload["id"])

    for member_id in (alice.id, bob.id):
        async with session_factory() as session:
            with pytest.raises(IntegrityError):
                await session.execute(
                    delete(ChatMember).where(
                        ChatMember.chat_id == chat_id,
                        ChatMember.user_id == member_id,
                    )
                )
                await session.commit()
            await session.rollback()

    member_response = await client.get(
        f"/chats/{chat_id}", headers=bearer(alice_token)
    )
    assert member_response.status_code == 200
