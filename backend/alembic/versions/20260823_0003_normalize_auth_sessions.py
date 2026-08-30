"""Derive authentication session ownership from its device.

Revision ID: 20260823_0003
Revises: 20260821_0002
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260823_0003"
down_revision: str | None = "20260821_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE auth_sessions
            SET revoked_at = CURRENT_TIMESTAMP
            FROM devices
            WHERE auth_sessions.device_id = devices.id
              AND auth_sessions.user_id <> devices.user_id
              AND auth_sessions.revoked_at IS NULL
            """
        )
    )
    op.drop_index("ix_auth_sessions_user_id", table_name="auth_sessions")
    op.drop_constraint(
        "auth_sessions_user_id_fkey", "auth_sessions", type_="foreignkey"
    )
    op.drop_column("auth_sessions", "user_id")


def downgrade() -> None:
    op.add_column(
        "auth_sessions", sa.Column("user_id", sa.Uuid(), nullable=True)
    )
    op.execute(
        sa.text(
            """
            UPDATE auth_sessions
            SET user_id = devices.user_id
            FROM devices
            WHERE auth_sessions.device_id = devices.id
            """
        )
    )
    op.alter_column("auth_sessions", "user_id", nullable=False)
    op.create_foreign_key(
        "auth_sessions_user_id_fkey",
        "auth_sessions",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
