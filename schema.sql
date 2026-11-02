-- ============================================
-- KPI Dashboard — Supabase PostgreSQL Schema
-- Jalankan SQL ini di Supabase SQL Editor
-- ============================================

-- Buat tabel utama
CREATE TABLE IF NOT EXISTS kpi_projects (
  id                          BIGSERIAL PRIMARY KEY,
  title                       TEXT,
  customer                    TEXT,
  product_description         TEXT,
  ordered_qty                 INTEGER DEFAULT 0,
  delivered_qty               INTEGER DEFAULT 0,
  assigned_to                 TEXT,
  sales                       TEXT,
  design                      TEXT,
  tags                        TEXT,
  stage                       TEXT,
  order_date                  TIMESTAMPTZ,
  deadline                    TIMESTAMPTZ,
  file_in                     TIMESTAMPTZ,
  progress_aw                 TIMESTAMPTZ,
  send_aw_ke_cust             TIMESTAMPTZ,
  acc_aw_dari_cust            TIMESTAMPTZ,
  send_ke_digital_print       TIMESTAMPTZ,
  receive_digital             TIMESTAMPTZ,
  send_digital_ke_cust        TIMESTAMPTZ,
  acc_digital_dari_cust       TIMESTAMPTZ,
  progress_dummy              TIMESTAMPTZ,
  send_dummy                  TIMESTAMPTZ,
  acc_dummy_dari_cust         TIMESTAMPTZ,
  progress_layout             TIMESTAMPTZ,
  lempar_file_ke_ctp          TIMESTAMPTZ,
  progress_layout_ctp         TIMESTAMPTZ,
  done_layout_ctp             TIMESTAMPTZ,
  review                      TIMESTAMPTZ,
  keluar_plat                 TIMESTAMPTZ,
  progress_revisi_aw          TIMESTAMPTZ,
  progress_revisi_dummy       TIMESTAMPTZ,
  manufacture_baru            BOOLEAN DEFAULT FALSE,
  manufacture_repeat          BOOLEAN DEFAULT FALSE,
  manufacture_repeat_perubahan BOOLEAN DEFAULT FALSE,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- Index untuk performa query
CREATE INDEX IF NOT EXISTS idx_kpi_design ON kpi_projects(design);
CREATE INDEX IF NOT EXISTS idx_kpi_order_date ON kpi_projects(order_date);
CREATE INDEX IF NOT EXISTS idx_kpi_stage ON kpi_projects(stage);
CREATE INDEX IF NOT EXISTS idx_kpi_title ON kpi_projects(title);

-- Enable Row Level Security (RLS)
ALTER TABLE kpi_projects ENABLE ROW LEVEL SECURITY;

-- RLS Policy: internal tool — full akses untuk semua user
CREATE POLICY "Allow public read"   ON kpi_projects FOR SELECT USING (true);
CREATE POLICY "Allow public insert" ON kpi_projects FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update" ON kpi_projects FOR UPDATE USING (true);
CREATE POLICY "Allow public delete" ON kpi_projects FOR DELETE USING (true);

-- Trigger untuk auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_timestamp
  BEFORE UPDATE ON kpi_projects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
