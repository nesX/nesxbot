-- ---------------------------------------------------------------------------
-- Esquema de NesxTrader (tablas propias del bot)
--
-- Las tablas del bot viven en el esquema `nesx` (creado por db/setup-roles.sql,
-- propiedad del rol nesx_bot). Las tablas de mercado (public.binance_candles,
-- public.binance_klines_1s) las provee market-tracker y son SOLO LECTURA — no
-- se tocan aquí.
--
-- Requisito: haber corrido db/setup-roles.sql una vez (crea el esquema nesx).
-- Idempotente: se puede correr múltiples veces sin error.
-- Aplicar con:  npm run init-db
-- ---------------------------------------------------------------------------

-- Nota: el esquema `nesx` lo crea db/setup-roles.sql (como postgres). Aquí NO se
-- crea — nesx_bot no tiene privilegio CREATE sobre la base (y no debe tenerlo).

-- Corridas de backtest. Una fila = una ejecución completa de una estrategia
-- sobre un símbolo y rango de fechas, con sus métricas agregadas.
CREATE TABLE IF NOT EXISTS nesx.backtest_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id     TEXT        NOT NULL,
  symbol          TEXT        NOT NULL,
  timeframe       TEXT        NOT NULL,
  from_ts         BIGINT      NOT NULL,           -- epoch ms
  to_ts           BIGINT      NOT NULL,           -- epoch ms
  initial_capital NUMERIC     NOT NULL,
  final_capital   NUMERIC     NOT NULL,
  total_trades    INTEGER     NOT NULL,
  win_rate        NUMERIC     NOT NULL,
  profit_factor   NUMERIC,                        -- null si es ∞ (sin pérdidas)
  max_drawdown    NUMERIC     NOT NULL,
  sharpe_ratio    NUMERIC,
  sortino_ratio   NUMERIC,
  expectancy      NUMERIC,
  metrics         JSONB       NOT NULL,           -- objeto Metrics completo
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- --- Capa de conocimiento (v2) ---
  params          JSONB,                          -- params resueltos de la estrategia (consultable)
  strategy_type   TEXT,                           -- tipo estable (spinning-top-fib), distinto del id dinámico
  engine_version  TEXT,                           -- versión del motor; invalida dedup si cambia la lógica de fills
  sample_window   TEXT,                           -- 'in_sample' | 'out_of_sample'
  experiment      TEXT,                           -- agrupa corridas bajo una hipótesis
  fingerprint     TEXT,                           -- hash de dedup (ver scripts/lib/fingerprint.ts)
  verdict         TEXT,                           -- 'promising' | 'rejected' | 'baseline' | null
  tags            TEXT[],
  notes           TEXT
);

-- Migraciones idempotentes para tablas creadas antes de la v2.
ALTER TABLE nesx.backtest_runs ADD COLUMN IF NOT EXISTS params         JSONB;
ALTER TABLE nesx.backtest_runs ADD COLUMN IF NOT EXISTS strategy_type  TEXT;
ALTER TABLE nesx.backtest_runs ADD COLUMN IF NOT EXISTS engine_version TEXT;
ALTER TABLE nesx.backtest_runs ADD COLUMN IF NOT EXISTS sample_window  TEXT;
ALTER TABLE nesx.backtest_runs ADD COLUMN IF NOT EXISTS experiment     TEXT;
ALTER TABLE nesx.backtest_runs ADD COLUMN IF NOT EXISTS fingerprint    TEXT;
ALTER TABLE nesx.backtest_runs ADD COLUMN IF NOT EXISTS verdict        TEXT;
ALTER TABLE nesx.backtest_runs ADD COLUMN IF NOT EXISTS tags           TEXT[];
ALTER TABLE nesx.backtest_runs ADD COLUMN IF NOT EXISTS notes          TEXT;

CREATE INDEX        IF NOT EXISTS idx_backtest_runs_strategy_id ON nesx.backtest_runs (strategy_id);
CREATE INDEX        IF NOT EXISTS idx_backtest_runs_created_at  ON nesx.backtest_runs (created_at DESC);
CREATE INDEX        IF NOT EXISTS idx_backtest_runs_symbol      ON nesx.backtest_runs (symbol);
CREATE INDEX        IF NOT EXISTS idx_backtest_runs_experiment  ON nesx.backtest_runs (experiment);
CREATE INDEX        IF NOT EXISTS idx_backtest_runs_params_gin  ON nesx.backtest_runs USING gin (params);
-- Dedup: una corrida única por (estrategia+params+símbolo+rango+versión de motor).
CREATE UNIQUE INDEX IF NOT EXISTS idx_backtest_runs_fingerprint ON nesx.backtest_runs (fingerprint);

-- Trades individuales de cada corrida. ON DELETE CASCADE: borrar un run borra
-- sus trades (BacktestRepository.deleteRun depende de esto).
CREATE TABLE IF NOT EXISTS nesx.backtest_trades (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID        NOT NULL REFERENCES nesx.backtest_runs (id) ON DELETE CASCADE,
  trade_id        TEXT        NOT NULL,
  strategy_id     TEXT        NOT NULL,
  symbol          TEXT        NOT NULL,
  direction       TEXT,
  entry_price     NUMERIC     NOT NULL,
  entry_ts        BIGINT      NOT NULL,           -- epoch ms
  exit_price      NUMERIC     NOT NULL,
  exit_ts         BIGINT      NOT NULL,           -- epoch ms
  exit_type       TEXT        NOT NULL,
  tp_level        INTEGER,
  pnl             NUMERIC     NOT NULL,
  pnl_percent     NUMERIC     NOT NULL,
  slippage        NUMERIC     NOT NULL,
  resolution_mode TEXT        NOT NULL,
  had_ambiguity   BOOLEAN     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backtest_trades_run_id ON nesx.backtest_trades (run_id);
