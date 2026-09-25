import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy.ext.asyncio import create_async_engine

from app.messages.models import Message


PRE_V7 = "20260907_0007"
V7 = "20260923_0008"
HEAD = "20260924_0009"
INDEX = "ix_messages_sender_user_id_id"
pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_DATABASE_URL"),
    reason="TEST_DATABASE_URL is required for PostgreSQL migration verification",
)


def migrate(connection, schema, target, *, downgrade=False):
    config = Config()
    config.set_main_option(
        "script_location", str(Path(__file__).parents[1] / "alembic")
    )
    script = ScriptDirectory.from_config(config)
    revisions = script._downgrade_revs if downgrade else script._upgrade_revs
    # Execute Alembic's real revision chain and version bookkeeping on the
    # existing connection, keeping all DDL inside the isolated schema.
    with EnvironmentContext(
        config, script, fn=lambda current, context: revisions(target, current)
    ) as environment:
        environment.configure(connection=connection, version_table_schema=schema)
        environment.run_migrations()


@pytest.fixture
async def migration_connection():
    engine = create_async_engine(os.environ["TEST_DATABASE_URL"])
    schema = "v7_migration_" + uuid.uuid4().hex
    try:
        async with engine.connect() as connection:
            try:
                await connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
                # No public fallback: tables, version table and trigger function
                # must all be resolved in this schema.
                await connection.exec_driver_sql(f'SET search_path TO "{schema}"')
                await connection.commit()
                yield connection, schema
            finally:
                await connection.rollback()
                await connection.exec_driver_sql(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
                await connection.commit()
    finally:
        await engine.dispose()


def seed_pre_v7(connection):
    metadata = sa.MetaData()
    metadata.reflect(connection)
    users = [uuid.UUID(int=100 + n) for n in range(3)]
    devices = [uuid.UUID(int=200 + n) for n in range(3)]
    chats = [uuid.UUID(int=300 + n) for n in range(3)]
    stamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for n, user in enumerate(users):
        connection.execute(metadata.tables["users"].insert(), {
            "id": user, "username": f"migration-{n}",
            "password_hash": "test-hash", "status": "ACTIVE",
        })
        connection.execute(metadata.tables["devices"].insert(), {
            "id": devices[n], "user_id": user, "name": f"device-{n}",
        })
        connection.execute(metadata.tables["device_mailboxes"].insert(), {
            "device_id": devices[n], "last_seq": 4 if n == 1 else 0,
        })
    for n, chat in enumerate(chats):
        connection.execute(metadata.tables["chats"].insert(), {"id": chat})
        pair = [users[0], users[1]] if n == 0 else (
            [users[0], users[2]] if n == 1 else [users[1], users[2]]
        )
        connection.execute(metadata.tables["chat_members"].insert(), [
            {"chat_id": chat, "user_id": user} for user in pair
        ])
        connection.execute(metadata.tables["direct_chat_pairs"].insert(), {
            "chat_id": chat, "user_low_id": min(pair), "user_high_id": max(pair),
        })
    for n, chat in [(2, chats[0]), (3, chats[0]), (1, chats[0]), (4, chats[1])]:
        connection.execute(metadata.tables["messages"].insert(), {
            "id": uuid.UUID(int=n), "chat_id": chat,
            "sender_user_id": users[0], "sender_device_id": devices[0],
            "client_message_id": uuid.UUID(int=400 + n),
            "created_at": stamp.replace(day=1 if n == 3 else 2),
        })
        recipient = 2 if n == 4 else 1
        delivered = stamp.replace(day=3) if n in (1, 2) else None
        connection.execute(metadata.tables["message_envelopes"].insert(), {
            "id": uuid.UUID(int=500 + n), "message_id": uuid.UUID(int=n),
            "recipient_device_id": devices[recipient], "mailbox_seq": n,
            "protocol_version": 1, "envelope_type": "ciphertext",
            "payload": None if n == 1 else bytes([n, 42]),
            "created_at": stamp, "expires_at": stamp.replace(day=30),
            "delivered_at": delivered, "payload_purged_at": delivered if n == 1 else None,
        })
    return users, devices, chats


def snapshot(connection, table, columns):
    return connection.execute(sa.text(
        f"SELECT {columns} FROM {table} ORDER BY id"
    )).all()


def verify_schema(connection):
    inspector = sa.inspect(connection)
    index = next(item for item in inspector.get_indexes("messages") if item["name"] == INDEX)
    model_index = next(item for item in Message.__table__.indexes if item.name == INDEX)
    assert index["column_names"] == [column.name for column in model_index.columns]
    assert not index["unique"]
    assert not next(item for item in inspector.get_columns("messages") if item["name"] == "chat_seq")["nullable"]
    assert "uq_messages_chat_seq" in {item["name"] for item in inspector.get_unique_constraints("messages")}
    assert "ck_messages_chat_seq_positive" in {item["name"] for item in inspector.get_check_constraints("messages")}
    assert "fk_message_envelopes_recipient_user" in {item["name"] for item in inspector.get_foreign_keys("message_envelopes")}
    assert "fk_chat_read_states_member" in {item["name"] for item in inspector.get_foreign_keys("chat_read_states")}


async def test_v7_migration_backfills_real_previous_schema(migration_connection):
    connection, schema = migration_connection

    def verify(connection):
        migrate(connection, schema, PRE_V7)
        assert connection.scalar(sa.text("SELECT version_num FROM alembic_version")) == PRE_V7
        assert connection.scalar(sa.text(
            "SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE p.oid = 'enforce_direct_chat_member_limit()'::regprocedure"
        )) == schema
        users, _, chats = seed_pre_v7(connection)
        message_columns = "id, chat_id, sender_user_id, sender_device_id, client_message_id, created_at"
        envelope_columns = "id, message_id, recipient_device_id, mailbox_seq, protocol_version, envelope_type, payload, created_at, expires_at, delivered_at, payload_purged_at"
        messages = snapshot(connection, "messages", message_columns)
        envelopes = snapshot(connection, "message_envelopes", envelope_columns)
        for iteration in range(2):
            migrate(connection, schema, HEAD)
            assert connection.scalar(sa.text("SELECT version_num FROM alembic_version")) == HEAD
            assert dict(connection.execute(sa.text("SELECT id, chat_seq FROM messages")).all()) == {
                uuid.UUID(int=3): 1, uuid.UUID(int=1): 2,
                uuid.UUID(int=2): 3, uuid.UUID(int=4): 1,
            }
            assert dict(connection.execute(sa.text("SELECT id, last_message_seq FROM chats")).all()) == dict(zip(chats, [3, 1, 0]))
            assert connection.scalar(sa.text("SELECT count(*) FROM chat_read_states")) == 0
            assert dict(connection.execute(sa.text("SELECT message_id, recipient_user_id FROM message_envelopes")).all()) == {
                uuid.UUID(int=n): users[2 if n == 4 else 1] for n in range(1, 5)
            }
            assert snapshot(connection, "messages", message_columns) == messages
            assert snapshot(connection, "message_envelopes", envelope_columns) == envelopes
            verify_schema(connection)
            if iteration == 0:
                migrate(connection, schema, V7, downgrade=True)
                assert INDEX not in {item["name"] for item in sa.inspect(connection).get_indexes("messages")}
                migrate(connection, schema, PRE_V7, downgrade=True)
                assert "chat_seq" not in {item["name"] for item in sa.inspect(connection).get_columns("messages")}
                assert snapshot(connection, "message_envelopes", envelope_columns) == envelopes

    await connection.run_sync(verify)


async def test_v7_empty_database_upgrade_downgrade_upgrade(migration_connection):
    connection, schema = migration_connection

    def verify(connection):
        for iteration in range(2):
            migrate(connection, schema, HEAD)
            verify_schema(connection)
            assert connection.scalar(sa.text("SELECT count(*) FROM messages")) == 0
            if iteration == 0:
                migrate(connection, schema, "base", downgrade=True)
                assert sa.inspect(connection).get_table_names() == ["alembic_version"]
                assert connection.scalar(sa.text(
                    "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = :schema"
                ), {"schema": schema}) == 0

    await connection.run_sync(verify)


async def test_sent_page_index_plan(migration_connection):
    connection, schema = migration_connection

    def verify(connection):
        migrate(connection, schema, PRE_V7)
        users, devices, chats = seed_pre_v7(connection)
        migrate(connection, schema, V7)
        connection.execute(sa.text("""
            INSERT INTO messages (id, chat_id, sender_user_id, sender_device_id, client_message_id, chat_seq)
            SELECT md5(n::text)::uuid, :chat,
                   CASE WHEN n % 100 = 0 THEN CAST(:sender AS uuid) ELSE CAST(:other AS uuid) END,
                   CASE WHEN n % 100 = 0 THEN CAST(:device AS uuid) ELSE CAST(:other_device AS uuid) END,
                   md5(('client-' || n)::text)::uuid, n + 3
            FROM generate_series(1, 20000) AS n
        """), {"chat": chats[0], "sender": users[0], "other": users[1], "device": devices[0], "other_device": devices[1]})
        connection.exec_driver_sql("ANALYZE messages")
        connection.exec_driver_sql("ANALYZE chats")
        connection.exec_driver_sql("ANALYZE chat_members")
        # Match the sent-page query's authorization join and UUID cursor, without
        # selectinload's independent envelope query. No planner settings forced.
        query = sa.text("""
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT messages.* FROM messages JOIN chats ON chats.id = messages.chat_id
            WHERE messages.sender_user_id = :sender AND messages.id > :cursor
              AND EXISTS (SELECT 1 FROM chat_members WHERE chat_members.chat_id = chats.id AND chat_members.user_id = :sender)
            ORDER BY messages.id LIMIT 51
        """)
        params = {"sender": users[0], "cursor": uuid.UUID(int=4)}
        before = connection.scalar(query, params)[0]
        migrate(connection, schema, HEAD)
        verify_schema(connection)
        # Measure from a new transaction: indexes built after HOT updates in the
        # migration transaction can temporarily be ineligible for that snapshot.
        connection.commit()
        after = connection.scalar(sa.text(str(query) + " /* after index creation */"), params)[0]

        def nodes(plan):
            yield plan
            for child in plan.get("Plans", []):
                yield from nodes(child)

        assert any(node.get("Index Name") == INDEX for node in nodes(after["Plan"]))
        for label, result in [("before", before), ("after", after)]:
            summary = [(node["Node Type"], node.get("Index Name"), node.get("Rows Removed by Filter")) for node in nodes(result["Plan"])]
            print(f"sent-page {label}: {summary}; shared hit blocks={result['Plan']['Shared Hit Blocks']}; execution ms={result['Execution Time']}")

    await connection.run_sync(verify)
