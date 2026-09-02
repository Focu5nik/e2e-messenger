import importlib.util
import uuid
from datetime import datetime
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def load_refresh_migration() -> ModuleType:
    migration_path = (
        Path(__file__).parents[1]
        / "alembic"
        / "versions"
        / "20260901_0004_refresh_token_rotation.py"
    )
    spec = importlib.util.spec_from_file_location(
        "refresh_token_rotation", migration_path
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_refresh_migration_revokes_and_marks_populated_legacy_sessions() -> None:
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    auth_sessions = sa.Table(
        "auth_sessions",
        metadata,
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )
    active_session_id = uuid.uuid4()
    revoked_session_id = uuid.uuid4()
    previous_revocation = datetime(2026, 1, 1, 12, 0, 0)

    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            auth_sessions.insert(),
            [
                {"id": active_session_id, "revoked_at": None},
                {"id": revoked_session_id, "revoked_at": previous_revocation},
            ],
        )

        migration = load_refresh_migration()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        assert connection.scalar(
            sa.select(sa.func.count())
            .select_from(auth_sessions)
            .where(auth_sessions.c.revoked_at.is_(None))
        ) == 0
        assert connection.scalar(
            sa.select(auth_sessions.c.revoked_at).where(
                auth_sessions.c.id == revoked_session_id
            )
        ) == previous_revocation
        assert connection.scalar(
            sa.text(
                "SELECT count(*) FROM auth_sessions WHERE refresh_cookie_bound != 0"
            )
        ) == 0
        assert "refresh_token_history" in sa.inspect(connection).get_table_names()

    engine.dispose()
