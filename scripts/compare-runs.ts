/**
 * scripts/compare-runs.ts
 *
 * Leaderboard de corridas persistidas en backtest_runs. Permite comparar
 * iteraciones de una estrategia y ver si un cambio mejoró las métricas.
 *
 * Consulta read-only directa (script operador) — no usa el repositorio de
 * producción para no ampliar su superficie.
 *
 * Uso:
 *   npm run compare-runs
 *   npm run compare-runs -- --strategy spinning-top-fib --sort profit_factor --limit 10
 *   npm run compare-runs -- --symbol BTCUSDT --min-trades 30 --json
 *
 * Flags:
 *   --strategy <id>   filtra por strategy_id (prefijo, LIKE 'id%')
 *   --symbol <SYM>    filtra por símbolo
 *   --sort <col>      profit_factor | expectancy | final_capital | win_rate |
 *                     sharpe_ratio | max_drawdown | created_at   (default created_at)
 *   --limit <n>       default 20
 *   --min-trades <n>  filtra corridas con pocas operaciones (default 0)
 *   --json            salida JSON en vez de tabla
 */

import { loadEnv }    from './lib/env.js';
import { createPool } from './lib/db.js';

const SORTABLE: Record<string, string> = {
  'profit_factor': 'profit_factor',
  'expectancy':    'expectancy',
  'final_capital': 'final_capital',
  'win_rate':      'win_rate',
  'sharpe_ratio':  'sharpe_ratio',
  'max_drawdown':  'max_drawdown',
  'created_at':    'created_at',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback = ''): string => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
  };
  const sortRaw = get('--sort', 'created_at');
  if (!SORTABLE[sortRaw]) {
    throw new Error(`--sort inválido: "${sortRaw}". Opciones: ${Object.keys(SORTABLE).join(', ')}`);
  }
  return {
    strategy:   get('--strategy'),
    symbol:     get('--symbol'),
    experiment: get('--experiment'),
    verdict:    get('--verdict'),
    window:     get('--window'),   // in_sample | out_of_sample
    sort:       SORTABLE[sortRaw]!,
    // max_drawdown: menor es mejor → ascendente; el resto descendente
    asc:        sortRaw === 'max_drawdown',
    limit:      parseInt(get('--limit', '20'), 10),
    minTrades:  parseInt(get('--min-trades', '0'), 10),
    json:       args.includes('--json'),
  };
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  loadEnv();
  const pool = createPool();

  try {
    const where: string[] = ['total_trades >= $1'];
    const params: unknown[] = [cfg.minTrades];
    if (cfg.strategy)   { params.push(`${cfg.strategy}%`); where.push(`strategy_id LIKE $${params.length}`); }
    if (cfg.symbol)     { params.push(cfg.symbol);          where.push(`symbol = $${params.length}`); }
    if (cfg.experiment) { params.push(cfg.experiment);      where.push(`experiment = $${params.length}`); }
    if (cfg.verdict)    { params.push(cfg.verdict);         where.push(`verdict = $${params.length}`); }
    if (cfg.window)     { params.push(cfg.window);          where.push(`sample_window = $${params.length}`); }
    params.push(cfg.limit);

    const sql = `
      SELECT id, strategy_id, symbol, timeframe, from_ts, to_ts,
             total_trades, win_rate, profit_factor, expectancy,
             max_drawdown, sharpe_ratio, final_capital, created_at,
             experiment, sample_window, verdict
      FROM backtest_runs
      WHERE ${where.join(' AND ')}
      ORDER BY ${cfg.sort} ${cfg.asc ? 'ASC' : 'DESC'} NULLS LAST
      LIMIT $${params.length}`;

    const { rows } = await pool.query(sql, params);

    if (cfg.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }

    if (rows.length === 0) {
      console.log('Sin corridas. Corre un backtest con persistencia:  npm run rbt -- --strategy <tipo> ...');
      return;
    }

    const fmt = (v: unknown, dec = 2) => v === null || v === undefined ? '-' : Number(v).toFixed(dec);
    const winShort = (w: unknown) => w === 'in_sample' ? 'IS' : w === 'out_of_sample' ? 'OOS' : '-';
    const header = [
      'Estrategia'.padEnd(20), 'Exp'.padEnd(14), 'W'.padStart(3), 'Trades'.padStart(7),
      'WinRate'.padStart(8), 'ProfF'.padStart(7), 'Expect'.padStart(8),
      'MaxDD'.padStart(7), 'Sharpe'.padStart(7), 'FinalCap'.padStart(10), 'Fecha'.padStart(11),
    ].join('  ');
    console.log(`\nLeaderboard — orden: ${cfg.sort} ${cfg.asc ? 'asc' : 'desc'}\n`);
    console.log(header);
    console.log('─'.repeat(header.length));
    for (const r of rows) {
      console.log([
        String(r['strategy_id']).padEnd(20),
        String(r['experiment'] ?? '-').slice(0, 14).padEnd(14),
        winShort(r['sample_window']).padStart(3),
        String(r['total_trades']).padStart(7),
        (fmt(r['win_rate'], 1) + '%').padStart(8),
        fmt(r['profit_factor']).padStart(7),
        fmt(r['expectancy']).padStart(8),
        (fmt(r['max_drawdown'], 1) + '%').padStart(7),
        fmt(r['sharpe_ratio']).padStart(7),
        ('$' + fmt(r['final_capital'], 0)).padStart(10),
        new Date(r['created_at'] as string).toISOString().slice(0, 10).padStart(11),
      ].join('  '));
    }
    console.log();
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
