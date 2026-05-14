-- ============================================================
-- Migration: 002_create_assets.sql
-- Description: Creates vehicle assets table with full
--              lifecycle tracking for telecom fleet management
-- Author: Tanvi Pawale
-- ============================================================

-- ── Assets Table ──────────────────────────────────────────────
-- Tracks all portable vehicle assets in the telecom fleet
CREATE TABLE assets (
    asset_id           NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id         VARCHAR2(50)                         NOT NULL,
    license_plate      VARCHAR2(20)                         NOT NULL,

    -- Vehicle classification
    vehicle_type       VARCHAR2(50)                         NOT NULL,

    -- Current operational status
    status             VARCHAR2(30)   DEFAULT 'AVAILABLE'   NOT NULL,

    -- Assignment
    assigned_to        NUMBER,        -- FK to users
    current_location   VARCHAR2(255),
    site_name          VARCHAR2(100),

    -- Lifecycle tracking
    procured_date      DATE,
    procurement_cost   NUMBER(12, 2),
    retired_date       DATE,
    retirement_reason  VARCHAR2(500),

    -- Metadata
    notes              VARCHAR2(1000),
    is_active          NUMBER(1)      DEFAULT 1             NOT NULL,
    created_by         NUMBER                               NOT NULL,
    created_at         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,

    -- Constraints
    CONSTRAINT uq_assets_vehicle_id     UNIQUE (vehicle_id),
    CONSTRAINT uq_assets_license_plate  UNIQUE (license_plate),
    CONSTRAINT chk_assets_status        CHECK  (status IN (
        'AVAILABLE',
        'DEPLOYED',
        'MAINTENANCE',
        'READY_FOR_HARVEST',
        'LOANED',
        'OUT_OF_SERVICE'
    )),
    CONSTRAINT chk_assets_vehicle_type  CHECK  (vehicle_type IN (
        'VAN',
        'TRUCK',
        'CAR',
        'MOTORCYCLE',
        'OTHER'
    )),
    CONSTRAINT chk_assets_active        CHECK  (is_active IN (0, 1)),
    CONSTRAINT fk_assets_assigned_to    FOREIGN KEY (assigned_to)
                                        REFERENCES users (user_id),
    CONSTRAINT fk_assets_created_by     FOREIGN KEY (created_by)
                                        REFERENCES users (user_id)
);

-- ── Asset Workflow Table ───────────────────────────────────────
-- Tracks the deployment workflow for each asset request
-- Requested → Assigned → Deployed → Released
CREATE TABLE asset_workflows (
    workflow_id     NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id        NUMBER                               NOT NULL,
    requested_by    NUMBER                               NOT NULL,
    assigned_by     NUMBER,
    workflow_status VARCHAR2(20)   DEFAULT 'REQUESTED'   NOT NULL,
    requested_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    assigned_at     TIMESTAMP,
    deployed_at     TIMESTAMP,
    released_at     TIMESTAMP,
    notes           VARCHAR2(500),

    CONSTRAINT fk_aw_asset        FOREIGN KEY (asset_id)
                                  REFERENCES assets (asset_id),
    CONSTRAINT fk_aw_requested_by FOREIGN KEY (requested_by)
                                  REFERENCES users (user_id),
    CONSTRAINT fk_aw_assigned_by  FOREIGN KEY (assigned_by)
                                  REFERENCES users (user_id),
    CONSTRAINT chk_aw_status      CHECK (workflow_status IN (
        'REQUESTED',
        'ASSIGNED',
        'DEPLOYED',
        'RELEASED'
    ))
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX idx_assets_status       ON assets (status);
CREATE INDEX idx_assets_assigned_to  ON assets (assigned_to);
CREATE INDEX idx_assets_vehicle_type ON assets (vehicle_type);
CREATE INDEX idx_assets_is_active    ON assets (is_active);
CREATE INDEX idx_aw_asset_id         ON asset_workflows (asset_id);
CREATE INDEX idx_aw_status           ON asset_workflows (workflow_status);

-- ── Audit Trigger ─────────────────────────────────────────────
CREATE OR REPLACE TRIGGER trg_assets_updated_at
    BEFORE UPDATE ON assets
    FOR EACH ROW
BEGIN
    :NEW.updated_at := CURRENT_TIMESTAMP;
END;
/

-- ── Comments ──────────────────────────────────────────────────
COMMENT ON TABLE  assets                  IS 'Telecom fleet vehicle assets';
COMMENT ON COLUMN assets.status           IS 'AVAILABLE | DEPLOYED | MAINTENANCE | READY_FOR_HARVEST | LOANED | OUT_OF_SERVICE';
COMMENT ON COLUMN assets.vehicle_type     IS 'VAN | TRUCK | CAR | MOTORCYCLE | OTHER';
COMMENT ON TABLE  asset_workflows         IS 'Tracks asset deployment: Requested > Assigned > Deployed > Released';
