-- ============================================================
-- Migration: 001_create_users.sql
-- Description: Creates users and teams tables with RBAC roles
-- Author: Tanvi Pawale
-- ============================================================

-- ── Teams Table ──────────────────────────────────────────────
-- A team groups technicians under a team lead
CREATE TABLE teams (
    team_id        NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_name      VARCHAR2(100)                        NOT NULL,
    description    VARCHAR2(500),
    created_by     NUMBER,                              -- FK added after users table
    is_active      NUMBER(1)      DEFAULT 1             NOT NULL,
    created_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,

    CONSTRAINT chk_teams_is_active CHECK (is_active IN (0, 1))
);

-- ── Users Table ───────────────────────────────────────────────
-- Core user accounts with role-based access control
CREATE TABLE users (
    user_id        NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username       VARCHAR2(50)                         NOT NULL,
    email          VARCHAR2(150)                        NOT NULL,
    password_hash  VARCHAR2(255)                        NOT NULL,
    first_name     VARCHAR2(100)                        NOT NULL,
    last_name      VARCHAR2(100)                        NOT NULL,

    -- RBAC: three roles in the system
    role           VARCHAR2(20)   DEFAULT 'TECHNICIAN'  NOT NULL,

    team_id        NUMBER,
    is_active      NUMBER(1)      DEFAULT 1             NOT NULL,
    last_login     TIMESTAMP,
    created_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,

    -- Constraints
    CONSTRAINT uq_users_username  UNIQUE (username),
    CONSTRAINT uq_users_email     UNIQUE (email),
    CONSTRAINT chk_users_role     CHECK  (role IN ('ADMIN', 'TEAM_LEAD', 'TECHNICIAN')),
    CONSTRAINT chk_users_active   CHECK  (is_active IN (0, 1)),
    CONSTRAINT fk_users_team      FOREIGN KEY (team_id)
                                  REFERENCES teams (team_id)
);

-- ── Add FK from teams back to users (creator) ────────────────
ALTER TABLE teams
    ADD CONSTRAINT fk_teams_created_by
    FOREIGN KEY (created_by) REFERENCES users (user_id);

-- ── Password Reset Tokens ─────────────────────────────────────
-- Stores temporary tokens for password reset flow
CREATE TABLE password_reset_tokens (
    token_id       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        NUMBER                               NOT NULL,
    token          VARCHAR2(255)                        NOT NULL,
    expires_at     TIMESTAMP                            NOT NULL,
    is_used        NUMBER(1)      DEFAULT 0             NOT NULL,
    created_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,

    CONSTRAINT fk_prt_user     FOREIGN KEY (user_id)
                               REFERENCES users (user_id),
    CONSTRAINT uq_prt_token    UNIQUE (token),
    CONSTRAINT chk_prt_is_used CHECK (is_used IN (0, 1))
);

-- ── Indexes ───────────────────────────────────────────────────
-- Speed up common lookups
CREATE INDEX idx_users_email    ON users (email);
CREATE INDEX idx_users_role     ON users (role);
CREATE INDEX idx_users_team     ON users (team_id);
CREATE INDEX idx_users_active   ON users (is_active);

-- ── Audit Trigger: updated_at ─────────────────────────────────
CREATE OR REPLACE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
BEGIN
    :NEW.updated_at := CURRENT_TIMESTAMP;
END;
/

CREATE OR REPLACE TRIGGER trg_teams_updated_at
    BEFORE UPDATE ON teams
    FOR EACH ROW
BEGIN
    :NEW.updated_at := CURRENT_TIMESTAMP;
END;
/

-- ── Comments ──────────────────────────────────────────────────
COMMENT ON TABLE  users                IS 'System users with role-based access';
COMMENT ON COLUMN users.role           IS 'ADMIN | TEAM_LEAD | TECHNICIAN';
COMMENT ON COLUMN users.password_hash  IS 'bcrypt hashed password';
COMMENT ON TABLE  teams                IS 'Groups of technicians managed by a team lead';
