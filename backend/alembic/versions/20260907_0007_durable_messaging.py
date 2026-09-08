"""Add durable messages and per-device envelope mailboxes.

Revision ID: 20260907_0007
Revises: 20260904_0006
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260907_0007"
down_revision: str | None = "20260904_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "messages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("chat_id", sa.Uuid(), nullable=False),
        sa.Column("sender_user_id", sa.Uuid(), nullable=False),
        sa.Column("sender_device_id", sa.Uuid(), nullable=False),
        sa.Column("client_message_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["chat_id"], ["chats.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["sender_device_id"], ["devices.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["sender_user_id"], ["users.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "sender_device_id",
            "client_message_id",
            name="uq_messages_sender_device_client_message",
        ),
    )
    op.create_index("ix_messages_chat_id", "messages", ["chat_id"])

    op.create_table(
        "device_mailboxes",
        sa.Column("device_id", sa.Uuid(), nullable=False),
        sa.Column(
            "last_seq", sa.BigInteger(), server_default="0", nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["device_id"], ["devices.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("device_id"),
    )
    op.execute(
        sa.text(
            """
            INSERT INTO device_mailboxes (device_id, last_seq)
            SELECT id, 0
            FROM devices
            """
        )
    )

    op.create_table(
        "message_envelopes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("recipient_device_id", sa.Uuid(), nullable=False),
        sa.Column("mailbox_seq", sa.BigInteger(), nullable=False),
        sa.Column("protocol_version", sa.Integer(), nullable=False),
        sa.Column("envelope_type", sa.String(length=32), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload_purged_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(payload IS NULL) = (payload_purged_at IS NOT NULL)",
            name="ck_message_envelopes_payload_purge_state",
        ),
        sa.ForeignKeyConstraint(
            ["message_id"], ["messages.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["recipient_device_id"], ["devices.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "message_id",
            "recipient_device_id",
            name="uq_message_envelopes_message_recipient",
        ),
        sa.UniqueConstraint(
            "recipient_device_id",
            "mailbox_seq",
            name="uq_message_envelopes_recipient_mailbox_seq",
        ),
    )
    op.create_index(
        "ix_message_envelopes_recipient_mailbox_seq",
        "message_envelopes",
        ["recipient_device_id", "mailbox_seq"],
    )
    op.create_index(
        "ix_message_envelopes_unpurged_expires_at",
        "message_envelopes",
        ["expires_at"],
        postgresql_where=sa.text("payload IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_message_envelopes_unpurged_expires_at",
        table_name="message_envelopes",
        postgresql_where=sa.text("payload IS NOT NULL"),
    )
    op.drop_index(
        "ix_message_envelopes_recipient_mailbox_seq",
        table_name="message_envelopes",
    )
    op.drop_table("message_envelopes")
    op.drop_table("device_mailboxes")
    op.drop_index("ix_messages_chat_id", table_name="messages")
    op.drop_table("messages")
