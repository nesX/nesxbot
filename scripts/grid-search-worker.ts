/**
 * scripts/grid-search-worker.ts
 *
 * Proceso hijo del grid search. Recibe por stdin un JSON con:
 *   { symbol, from, to, candles1m, combos }
 *
 * Escribe por stdout un JSON con los resultados al finalizar.
 * El progreso se escribe por stderr para no contaminar stdout.
 */

import { loadEnv }                  from './lib/env.js';
import { createPool }               from './lib/db.js';
import { runBacktest }              from './lib/backtest.js';
import InMemoryCandleRepository     from './lib/InMemoryCandleRepository.js';
import CandleRepository             from '../src/data/CandleRepository.js';
import SpinningTopFibStrategy       from '../src/strategy/strategies/SpinningTopFibStrategy.js';
import type { Candle }              from '../src/types.js';

// ---------------------------------------------------------------------------
// Tipos compartidos con grid-search.ts
// ---------------------------------------------------------------------------

export interface ComboParams {
  candleInterval:    number;
  tp1RR:             number;
  tp2RR:             number | null;
  z1min:             number;
  z1max:             number;
  tp1SizePercent:    number;
  moveSlToBreakeven: boolean;
  maxBodyPercent:    number;
  minRangePercent:   number;
  minVolume:         number | null;
}

export interface ComboResult extends ComboParams {
  totalTrades:   number;
  winRate:       number;
  profitFactor:  number;
  maxDrawdown:   number;
  expectancy:    number;
  finalCapital:  number;
  sharpeRatio:   number;
  sortinoRatio:  number;
}

interface WorkerInput {
  symbol:    string;
  from:      number;
  to:        number;
  z2min:     number | null;
  z2max:     number | null;
  candles1m: Candle[];
  combos:    ComboParams[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

loadEnv();

const chunks: Buffer[] = [];
process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
process.stdin.on('end', async () => {
  const input: WorkerInput = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  const { symbol, from, to, z2min, z2max, candles1m, combos } = input;

  // Con el cache de velas 1s en FillSimulator, los workers casi no necesitan
  // consultar PG. Reducir el pool a 2 conexiones para no saturar el servidor
  // cuando hay múltiples workers corriendo en paralelo.
  const pool     = createPool({ max: 2 });
  const realRepo = new CandleRepository({ db: pool });
  const repo     = new InMemoryCandleRepository(realRepo);
  repo.loadFromData(symbol, candles1m);

  const emit = (msg: object) => process.stdout.write(JSON.stringify(msg) + '\n');

  const results: ComboResult[] = [];
  let done = 0;

  for (const params of combos) {
    done++;

    try {
      const strategy = new SpinningTopFibStrategy({
        candleInterval:    params.candleInterval,
        maxBodyPercent:    params.maxBodyPercent,
        minRangePercent:   params.minRangePercent,
        minVolume:         params.minVolume ?? undefined,
        zone1:             { min: params.z1min, max: params.z1max },
        zone2:             z2min != null && z2max != null ? { min: z2min, max: z2max } : null,
        spinningTopMode:   'SINGLE_LAST',
        tp1SizePercent:    params.tp1SizePercent,
        tp1RR:             params.tp1RR,
        tp2RR:             params.tp2RR,
        moveSlToBreakeven: params.moveSlToBreakeven,
        riskPercent:       1,
      });

      const { report } = await runBacktest(strategy, {
        symbol,
        from,
        to,
        warmupCandles: params.candleInterval * 20,
        silent: true,
      }, pool, repo);

      const m = report.metrics;
      results.push({
        ...params,
        totalTrades:  m.totalTrades,
        winRate:      m.winRate,
        profitFactor: m.profitFactor === Infinity ? 999 : m.profitFactor,
        maxDrawdown:  m.maxDrawdown,
        expectancy:   m.expectancy,
        finalCapital: m.finalCapital,
        sharpeRatio:  m.sharpeRatio  ?? 0,
        sortinoRatio: m.sortinoRatio ?? 0,
      });
    } catch {
      // ignorar combo inválida
    }

    // Progreso después de cada combo (tanto éxito como error)
    emit({ type: 'progress', done, total: combos.length });
  }

  await pool.end();
  emit({ type: 'results', data: results });
});
