"""Multi-device routing metadata and monotonic chat read cursors."""

from alembic import op
import sqlalchemy as sa


revision = "20260923_0008"
down_revision = "20260907_0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("chats", sa.Column("last_message_seq", sa.BigInteger(), nullable=False, server_default="0"))
    op.add_column("messages", sa.Column("chat_seq", sa.BigInteger(), nullable=True))
    op.execute("""
        WITH positions AS (
            SELECT id, row_number() OVER (PARTITION BY chat_id ORDER BY created_at, id) AS seq
            FROM messages
        ) UPDATE messages SET chat_seq = positions.seq FROM positions
        WHERE messages.id = positions.id
    """)
    op.execute("""
        UPDATE chats SET last_message_seq = positions.seq
        FROM (SELECT chat_id, max(chat_seq) AS seq FROM messages GROUP BY chat_id) positions
        WHERE chats.id = positions.chat_id
    """)
    op.alter_column("messages", "chat_seq", nullable=False)
    op.create_unique_constraint("uq_messages_chat_seq", "messages", ["chat_id", "chat_seq"])
    op.create_check_constraint("ck_messages_chat_seq_positive", "messages", "chat_seq > 0")
    op.add_column("message_envelopes", sa.Column("recipient_user_id", sa.Uuid(), nullable=True))
    op.execute("""
        UPDATE message_envelopes SET recipient_user_id = devices.user_id
        FROM devices WHERE devices.id = message_envelopes.recipient_device_id
    """)
    op.alter_column("message_envelopes", "recipient_user_id", nullable=False)
    op.create_foreign_key("fk_message_envelopes_recipient_user", "message_envelopes", "users", ["recipient_user_id"], ["id"], ondelete="RESTRICT")
    op.create_table(
        "chat_read_states",
        sa.Column("chat_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("last_read_seq", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("chat_id", "user_id"),
        sa.ForeignKeyConstraint(["chat_id", "user_id"], ["chat_members.chat_id", "chat_members.user_id"], ondelete="CASCADE", name="fk_chat_read_states_member"),
        sa.CheckConstraint("last_read_seq >= 0", name="ck_chat_read_states_seq"),
    )


def downgrade() -> None:
    op.drop_table("chat_read_states")
    op.drop_constraint("fk_message_envelopes_recipient_user", "message_envelopes", type_="foreignkey")
    op.drop_column("message_envelopes", "recipient_user_id")
    op.drop_constraint("ck_messages_chat_seq_positive", "messages", type_="check")
    op.drop_constraint("uq_messages_chat_seq", "messages", type_="unique")
    op.drop_column("messages", "chat_seq")
    op.drop_column("chats", "last_message_seq")
