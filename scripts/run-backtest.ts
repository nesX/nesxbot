/**
 * scripts/run-backtest.ts
 *
 * CLI de backtest con salida JSON determinista — el canal de feedback del
 * bucle de iteración de la IA. Recibe un tipo de estrategia + params y emite
 * por stdout un único objeto JSON con métricas y advertencias de cordura.
 *
 * Persiste cada corrida en nesx.backtest_runs con su huella (fingerprint) para
 * NO re-correr lo ya hecho con el mismo motor (dedup). Es el "contrato de job"
 * que más adelante podría implementar un engine en Rust o consumir un optimizador
 * en Python: params → JSON in, métricas → JSON out.
 *
 * Uso:
 *   npx tsx scripts/run-backtest.ts --strategy spinning-top-fib --from 2024-01-01 --to 2024-06-30
 *   npx tsx scripts/run-backtest.ts --strategy spinning-top-fib --from 2024-01-01 --to 2024-06-30 \
 *       --oos-from 2024-07-01 --oos-to 2024-12-31 --experiment exp-body-width \
 *       --params '{"maxBodyPercent":40,"zone1":{"min":1.9,"max":2.2}}'
 *
 * Flags:
 *   --strategy <tipo>     (requerido) tipo registrado en strategyFactory
 *   --symbol <SYM>        default BTCUSDT
 *   --from / --to         (requerido) rango in-sample, YYYY-MM-DD
 *   --oos-from / --oos-to opcional, rango out-of-sample (valida overfitting)
 *   --params '<json>'     params de la estrategia (se mergean sobre defaults)
 *   --experiment <id>     agrupa la corrida bajo una hipótesis (ver docs/experiments/)
 *   --capital <n>         default 10000
 *   --risk <n>            default 1
 *   --warmup <n>          velas de warm-up, default 120
 *   --min-trades <n>      umbral de cordura, default 30
 *   --force               re-corre aunque exista una corrida con la misma huella
 *   --no-persist          no guardar en nesx.backtest_runs (implica --force)
 *   --pretty              JSON indentado (default compacto)
 */

import { loadEnv }       from './lib/env.js';
import { createPool }    from './lib/db.js';
import type { Pool }     from './lib/db.js';
import { runBacktest }   from './lib/backtest.js';
import { buildStrategy } from './lib/strategyFactory.js';
import { computeFingerprint } from './lib/fingerprint.js';
import { ENGINE_VERSION } from '../src/backtest/engineVersion.js';
import type { Metrics } from '../src/types.js';

const PESSIMISTIC_WARN_PCT = 20;  // % de fills PESSIMISTIC que dispara advertencia

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback = ''): string => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
  };
  const has = (flag: string) => args.includes(flag);
  const day = (s: string, endOfDay = false) =>
    Date.parse(`${s}T${endOfDay ? '23:59:59' : '00:00:00'}Z`);

  const paramsRaw = get('--params');
  let params: Record<string, unknown> = {};
  if (paramsRaw) {
    try { params = JSON.parse(paramsRaw); }
    catch (e) { throw new Error(`--params no es JSON válido: ${(e as Error).message}`); }
  }

  const oosFrom = get('--oos-from');
  const oosTo   = get('--oos-to');
  const persist = !has('--no-persist');

  return {
    strategyType: get('--strategy'),
    symbol:       get('--symbol', 'BTCUSDT'),
    from:         day(get('--from', '2024-01-01')),
    to:           day(get('--to',   '2024-06-30'), true),
    oos: (oosFrom && oosTo) ? { from: day(oosFrom), to: day(oosTo, true) } : null,
    params,
    experiment:   get('--experiment') || null,
    capital:      parseFloat(get('--capital', '10000')),
    risk:         parseFloat(get('--risk', '1')),
    warmup:       parseInt(get('--warmup', '120'), 10),
    minTrades:    parseInt(get('--min-trades', '30'), 10),
    persist,
    force:        has('--force') || !persist,
    pretty:       has('--pretty'),
  };
}

type Cfg = ReturnType<typeof parseArgs>;

interface WindowSummary {
  runId: string | null;
  cached: boolean;
  from: string;
  to: string;
  totalTrades: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  maxDrawdown: number;
  sharpeRatio: number;
  sortinoRatio: number;
  finalCapital: number;
  tpBreakdown: Metrics['tpBreakdown'];
  resolutionConfidence: Metrics['resolution_confidence'];
  pessimisticPenalties: number;
}

const round = (n: number) => Math.round(n * 10000) / 10000;
const iso   = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function summarize(m: Metrics, runId: string | null, cached: boolean, from: number, to: number): WindowSummary {
  return {
    runId,
    cached,
    from: iso(from),
    to:   iso(to),
    totalTrades:   m.totalTrades,
    winRate:       round(m.winRate),
    profitFactor:  isFinite(m.profitFactor) ? round(m.profitFactor) : null,
    expectancy:    round(m.expectancy),
    maxDrawdown:   round(m.maxDrawdown),
    sharpeRatio:   round(m.sharpeRatio),
    sortinoRatio:  round(m.sortinoRatio),
    finalCapital:  round(m.finalCapital),
    tpBreakdown:   m.tpBreakdown,
    resolutionConfidence: m.resolution_confidence,
    pessimisticPenalties: m.pessimistic_penalties,
  };
}

function sanityWarnings(label: string, s: WindowSummary, minTrades: number): string[] {
  const w: string[] = [];
  if (s.totalTrades < minTrades) {
    w.push(`[${label}] pocas operaciones (${s.totalTrades} < ${minTrades}) — métricas poco fiables`);
  }
  if (s.resolutionConfidence.PESSIMISTIC > PESSIMISTIC_WARN_PCT) {
    w.push(`[${label}] ${s.resolutionConfidence.PESSIMISTIC.toFixed(0)}% de fills en modo PESSIMISTIC — baja confianza en los fills`);
  }
  return w;
}

/**
 * Corre (o reutiliza) un backtest para una ventana. Devuelve el resumen.
 * Dedup: si ya existe una corrida con la misma huella y no se pidió --force,
 * reutiliza la métrica guardada en vez de re-ejecutar.
 */
async function runWindow(pool: Pool, cfg: Cfg, label: string, from: number, to: number): Promise<WindowSummary> {
  // Instancia nueva por ventana: las estrategias tienen estado interno.
  const { strategy, resolvedParams } = buildStrategy(cfg.strategyType, cfg.params);

  const fingerprint = computeFingerprint({
    engineVersion: ENGINE_VERSION,
    strategyType:  cfg.strategyType,
    params:        resolvedParams,
    symbol:        cfg.symbol,
    from, to,
  });

  // Dedup
  if (!cfg.force) {
    const hit = await pool.query('SELECT id, metrics FROM backtest_runs WHERE fingerprint = $1 LIMIT 1', [fingerprint]);
    if (hit.rows.length > 0) {
      const row = hit.rows[0]!;
      return summarize(row['metrics'] as Metrics, row['id'] as string, true, from, to);
    }
  }

  const result = await runBacktest(strategy, {
    symbol: cfg.symbol, from, to,
    initialCapital: cfg.capital, riskPercent: cfg.risk,
    warmupCandles: cfg.warmup, persist: false, silent: true,
  }, pool);

  const m = result.report.metrics;
  let runId: string | null = null;

  if (cfg.persist) {
    const sampleWindow = label === 'IS' ? 'in_sample' : 'out_of_sample';
    const ins = await pool.query(
      `INSERT INTO backtest_runs (
         strategy_id, strategy_type, symbol, timeframe, from_ts, to_ts,
         initial_capital, final_capital, total_trades, win_rate, profit_factor,
         max_drawdown, sharpe_ratio, sortino_ratio, expectancy, metrics,
         params, engine_version, sample_window, experiment, fingerprint
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [
        strategy.id, cfg.strategyType, cfg.symbol, '1m', from, to,
        cfg.capital, m.finalCapital, m.totalTrades, m.winRate,
        isFinite(m.profitFactor) ? m.profitFactor : null,
        m.maxDrawdown, m.sharpeRatio, m.sortinoRatio, m.expectancy, JSON.stringify(m),
        JSON.stringify(resolvedParams), ENGINE_VERSION, sampleWindow, cfg.experiment, fingerprint,
      ]
    );
    runId = ins.rows[0]!['id'] as string;
  }

  return summarize(m, runId, false, from, to);
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  if (!cfg.strategyType) {
    throw new Error('Falta --strategy <tipo>. Ej: --strategy spinning-top-fib');
  }

  loadEnv();
  const pool = createPool();

  try {
    const warnings: string[] = [];
    const { resolvedParams } = buildStrategy(cfg.strategyType, cfg.params);

    const inSample = await runWindow(pool, cfg, 'IS', cfg.from, cfg.to);
    warnings.push(...sanityWarnings('IS', inSample, cfg.minTrades));

    let outOfSample: WindowSummary | null = null;
    if (cfg.oos) {
      outOfSample = await runWindow(pool, cfg, 'OOS', cfg.oos.from, cfg.oos.to);
      warnings.push(...sanityWarnings('OOS', outOfSample, cfg.minTrades));

      const isPF  = inSample.profitFactor;
      const oosPF = outOfSample.profitFactor;
      if (isPF !== null && isPF > 1 && oosPF !== null && oosPF < 1) {
        warnings.push(`[overfitting] rentable in-sample (PF ${isPF}) pero no out-of-sample (PF ${oosPF}) — sospecha de sobreajuste`);
      }
    }

    const output = {
      ok: warnings.length === 0,
      engineVersion: ENGINE_VERSION,
      experiment: cfg.experiment,
      strategy: { type: cfg.strategyType, id: buildStrategy(cfg.strategyType, cfg.params).strategy.id, params: resolvedParams },
      symbol: cfg.symbol,
      inSample,
      outOfSample,
      warnings,
    };

    process.stdout.write(JSON.stringify(output, null, cfg.pretty ? 2 : 0) + '\n');
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n');
  process.exit(1);
});
