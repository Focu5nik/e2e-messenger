"""Add canonical direct chats and membership lookup.

Revision ID: 20260903_0005
Revises: 20260901_0004
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260903_0005"
down_revision: str | None = "20260901_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chats",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "type", sa.String(length=16), server_default="DIRECT", nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("type = 'DIRECT'", name="ck_chats_type_direct"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "chat_members",
        sa.Column("chat_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["chat_id"], ["chats.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("chat_id", "user_id"),
    )
    op.create_index(
        "ix_chat_members_user_id_chat_id",
        "chat_members",
        ["user_id", "chat_id"],
    )
    op.create_table(
        "direct_chat_pairs",
        sa.Column("chat_id", sa.Uuid(), nullable=False),
        sa.Column("user_low_id", sa.Uuid(), nullable=False),
        sa.Column("user_high_id", sa.Uuid(), nullable=False),
        sa.CheckConstraint(
            "user_low_id < user_high_id", name="ck_direct_chat_pairs_canonical"
        ),
        sa.ForeignKeyConstraint(["chat_id"], ["chats.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["chat_id", "user_high_id"],
            ["chat_members.chat_id", "chat_members.user_id"],
            name="fk_direct_chat_pairs_high_member",
        ),
        sa.ForeignKeyConstraint(
            ["chat_id", "user_low_id"],
            ["chat_members.chat_id", "chat_members.user_id"],
            name="fk_direct_chat_pairs_low_member",
        ),
        sa.ForeignKeyConstraint(
            ["user_high_id"], ["users.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["user_low_id"], ["users.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("chat_id"),
        sa.UniqueConstraint(
            "user_low_id", "user_high_id", name="uq_direct_chat_pairs_users"
        ),
    )


def downgrade() -> None:
    op.drop_table("direct_chat_pairs")
    op.drop_index("ix_chat_members_user_id_chat_id", table_name="chat_members")
    op.drop_table("chat_members")
    op.drop_table("chats")
