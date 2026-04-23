-- ORCA PII Vault schema — applied by orca-deploy createSqlServer() during
-- install. Kept here as a standalone script so an operator can apply it by
-- hand if sqlcmd was not available at install time.
--
-- Usage:
--   sqlcmd -S <server>.database.windows.net \
--          -d orca-pii-vault \
--          -U <admin> \
--          -P "<password>" \
--          -i pii-vault-ddl.sql
--
-- Idempotent — safe to re-apply.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'pii_tokens')
BEGIN
    CREATE TABLE dbo.pii_tokens (
        token           NVARCHAR(64)    NOT NULL PRIMARY KEY,
        kind            NVARCHAR(32)    NOT NULL,
        encrypted_value NVARCHAR(MAX)   NOT NULL,
        wrapped_dek     NVARCHAR(MAX)   NOT NULL,
        iv              NVARCHAR(64)    NOT NULL,
        auth_tag        NVARCHAR(64)    NOT NULL,
        customer_slug   NVARCHAR(32)    NOT NULL,
        created_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
        INDEX IX_pii_tokens_customer_kind NONCLUSTERED (customer_slug, kind)
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'knowledge_equity_events')
BEGIN
    CREATE TABLE dbo.knowledge_equity_events (
        event_id        UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        user_oid        NVARCHAR(64)    NOT NULL,
        customer_slug   NVARCHAR(32)    NOT NULL,
        event_type      NVARCHAR(32)    NOT NULL,
        points          INT             NOT NULL,
        ref_point_id    NVARCHAR(128)   NULL,
        created_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
        INDEX IX_ke_events_user NONCLUSTERED (user_oid),
        INDEX IX_ke_events_customer NONCLUSTERED (customer_slug, created_at)
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'knowledge_equity_balances')
BEGIN
    CREATE TABLE dbo.knowledge_equity_balances (
        user_oid        NVARCHAR(64)    NOT NULL PRIMARY KEY,
        customer_slug   NVARCHAR(32)    NOT NULL,
        balance         INT             NOT NULL DEFAULT 0,
        updated_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME()
    );
END;
