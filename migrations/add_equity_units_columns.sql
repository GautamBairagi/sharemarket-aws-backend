-- Migration: Add Equity Units vs Lots Support
-- Date: 2026-05-07
-- Purpose: Add columns to support NSE Equity Units/Lots mode

-- Add new columns to trades table
ALTER TABLE trades ADD COLUMN IF NOT EXISTS (
    qty_input DECIMAL(10, 2) COMMENT 'Quantity entered by user',
    actual_qty DECIMAL(10, 2) COMMENT 'Calculated quantity (qty × lot_size for lots mode)',
    lot_size_at_entry INT DEFAULT 1 COMMENT 'Lot size at time of trade',
    trade_mode VARCHAR(10) COMMENT 'UNITS or LOTS',
    turnover DECIMAL(15, 2) COMMENT 'price × actual_qty',
    leverage_used DECIMAL(5, 2) COMMENT 'Leverage applied',
    equity_units_mode TINYINT(1) DEFAULT 0 COMMENT 'User setting at trade time'
);

-- Update existing trades to populate new columns
UPDATE trades
SET
    qty_input = COALESCE(qty, qty_input),
    actual_qty = COALESCE(qty, actual_qty),
    lot_size_at_entry = 1,
    trade_mode = CASE
        WHEN market_type = 'MCX' THEN 'LOTS'
        WHEN market_type = 'EQUITY' THEN COALESCE(trade_mode, 'LOTS')
        ELSE 'LOTS'
    END,
    turnover = COALESCE(ROUND(entry_price * COALESCE(qty, 0), 2), turnover),
    leverage_used = CASE
        WHEN market_type = 'MCX' THEN 1  -- MCX doesn't use leverage like equity
        ELSE 5  -- Default holding leverage
    END
WHERE qty_input IS NULL;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_trades_actual_qty ON trades(user_id, actual_qty, status);

-- Verify changes
SELECT
    COUNT(*) as total_trades,
    SUM(CASE WHEN qty_input IS NOT NULL THEN 1 ELSE 0 END) as with_qty_input,
    SUM(CASE WHEN actual_qty IS NOT NULL THEN 1 ELSE 0 END) as with_actual_qty
FROM trades;

-- Show sample of updated trades
SELECT
    id,
    symbol,
    qty_input,
    actual_qty,
    lot_size_at_entry,
    trade_mode,
    turnover,
    leverage_used
FROM trades
WHERE status = 'OPEN'
LIMIT 5;
