"""Index outgoing metadata pages by sender and message cursor."""

from alembic import op


revision = "20260924_0009"
down_revision = "20260923_0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_messages_sender_user_id_id", "messages", ["sender_user_id", "id"]
    )


def downgrade() -> None:
    op.drop_index("ix_messages_sender_user_id_id", table_name="messages")
