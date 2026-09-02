"""Add refresh-token rotation history for reuse detection.

Revision ID: 20260901_0004
Revises: 20260823_0003
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260901_0004"
down_revision: str | None = "20260823_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "auth_sessions",
        sa.Column(
            "refresh_cookie_bound",
            sa.Boolean(),
            server_default=sa.false(),
            nullable=False,
        ),
    )
    op.create_table(
        "refresh_token_history",
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("auth_session_id", sa.Uuid(), nullable=False),
        sa.Column(
            "consumed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["auth_session_id"], ["auth_sessions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("token_hash"),
    )
    op.create_index(
        "ix_refresh_token_history_auth_session_id",
        "refresh_token_history",
        ["auth_session_id"],
    )
    # Tokens issued before this migration may still exist in JavaScript-readable
    # browser storage. They cannot be moved into an HttpOnly cookie safely, so
    # invalidate those families and require a fresh cookie-backed login.
    op.execute(
        sa.text(
            """
            UPDATE auth_sessions
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE revoked_at IS NULL
            """
        )
    )


def downgrade() -> None:
    op.drop_index(
        "ix_refresh_token_history_auth_session_id",
        table_name="refresh_token_history",
    )
    op.drop_table("refresh_token_history")
    op.drop_column("auth_sessions", "refresh_cookie_bound")
