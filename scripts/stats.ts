/**
 * scripts/stats.ts
 *
 * CLI principal del motor de estadísticas de mercado de NesxTrader.
 *
 * Uso:
 *   npm run stats -- --symbol BTCUSDT --timeframe 1m \
 *     --from 2025-01-01 --to 2025-03-31 \
 *     --analyzer volume-followthrough --vol-threshold 500 --lookahead 5 \
 *     --output table
 *
 *   npm run stats -- --symbol BTCUSDT --timeframe 1m \
 *     --from 2025-01-01 --to 2025-01-31 \
 *     --analyzer consecutive-streaks --max-streak 10 \
 *     --output table
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv }     from './lib/env.js';
import { createPool }  from './lib/db.js';
import CandleRepository from '../src/data/CandleRepository.js';

import { StatsEngine }           from './stats/StatsEngine.js';
import type { Analyzer }         from './stats/types.js';
import { VolumeFollowthrough }    from './stats/analyzers/VolumeFollowthrough.js';
import { ConsecutiveStreaks }     from './stats/analyzers/ConsecutiveStreaks.js';
import { MarubozuContinuation }  from './stats/analyzers/MarubozuContinuation.js';
import { WicklessRangeDist }     from './stats/analyzers/WicklessRangeDist.js';
import { RSIZoneDist }           from './stats/analyzers/RSIZoneDist.js';
import { OversoldBounce }        from './stats/analyzers/OversoldBounce.js';
import { EmaBounce }             from './stats/analyzers/EmaBounce.js';
import { TableReporter }         from './stats/reporters/TableReporter.js';
import { JsonReporter }          from './stats/reporters/JsonReporter.js';
import { CsvReporter }           from './stats/reporters/CsvReporter.js';

// ---------------------------------------------------------------------------
// Tipos internos de parseo de CLI
// ---------------------------------------------------------------------------

interface AnalyzerSpec {
  name: string;
  args: Record<string, string>;
}

interface CliArgs {
  symbol:    string;
  timeframe: string;
  from:      number;
  to:        number;
  analyzers: AnalyzerSpec[];
  output:    'table' | 'json' | 'csv';
  save?:     string;   // nombre base del archivo; undefined = no guardar
}

// ---------------------------------------------------------------------------
// Parser de argumentos
// ---------------------------------------------------------------------------

/**
 * Parsea process.argv en la estructura CliArgs.
 *
 * El formato es:
 *   --flag value                     → args globales
 *   --analyzer nombre --flag value   → args del analyzer
 *
 * Cada --analyzer abre un nuevo bloque de args. Los flags que siguen
 * pertenecen al último --analyzer abierto hasta que aparece otro --analyzer
 * o un flag global conocido.
 */
function parseArgs(argv: string[]): CliArgs {
  const GLOBAL_FLAGS = new Set(['--symbol', '--timeframe', '--from', '--to', '--output', '--analyzer', '--save']);

  const global: Record<string, string> = {};
  const analyzerSpecs: AnalyzerSpec[] = [];
  let currentAnalyzer: AnalyzerSpec | null = null;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === '--analyzer') {
      // Cerrar el analyzer anterior si hay uno
      if (currentAnalyzer) analyzerSpecs.push(currentAnalyzer);
      const name = argv[i + 1];
      if (!name || name.startsWith('--')) {
        die('--analyzer requiere un nombre (ej: --analyzer volume-followthrough)');
      }
      currentAnalyzer = { name, args: {} };
      i += 2;
      continue;
    }

    if (arg.startsWith('--') && !GLOBAL_FLAGS.has(arg)) {
      // Flag de analyzer
      const key   = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : 'true';
      const skip  = value !== 'true' ? 2 : 1;

      if (currentAnalyzer) {
        currentAnalyzer.args[key] = value;
      } else {
        global[key] = value;
      }
      i += skip;
      continue;
    }

    if (arg.startsWith('--')) {
      const key   = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : 'true';
      const skip  = value !== 'true' ? 2 : 1;
      global[key] = value;
      i += skip;
      continue;
    }

    // Token sin -- (valor suelto, ignorar)
    i++;
  }

  // Cerrar el último analyzer
  if (currentAnalyzer) analyzerSpecs.push(currentAnalyzer);

  // Validaciones globales
  if (!global['from']) die('--from es requerido (ej: --from 2025-01-01)');
  if (!global['to'])   die('--to es requerido (ej: --to 2025-03-31)');
  if (analyzerSpecs.length === 0) die('Al menos un --analyzer es requerido');

  const fromMs = Date.parse(`${global['from']}T00:00:00Z`);
  const toMs   = Date.parse(`${global['to']}T23:59:59Z`);

  if (isNaN(fromMs)) die(`--from valor inválido: '${global['from']}'`);
  if (isNaN(toMs))   die(`--to valor inválido: '${global['to']}'`);

  const output = (global['output'] ?? 'table') as CliArgs['output'];
  if (!['table', 'json', 'csv'].includes(output)) {
    die(`--output debe ser 'table', 'json' o 'csv'. Recibido: '${output}'`);
  }

  return {
    symbol:    global['symbol']    ?? 'BTCUSDT',
    timeframe: global['timeframe'] ?? '1m',
    from:      fromMs,
    to:        toMs,
    analyzers: analyzerSpecs,
    output,
    save:      global['save'],
  };
}

// ---------------------------------------------------------------------------
// Construcción de analyzers desde specs
// ---------------------------------------------------------------------------

function buildAnalyzers(specs: AnalyzerSpec[]): Analyzer[] {
  return specs.map(spec => {
    switch (spec.name) {
      case 'volume-followthrough': {
        const args = spec.args;

        // Parsear parámetros de volumen
        const hasThreshold = args['vol-threshold'] !== undefined;
        const hasMa        = args['vol-ma'] !== undefined;

        if (!hasThreshold && !hasMa) {
          die(
            "volume-followthrough requiere --vol-threshold N  O  " +
            "--vol-ma sma|ema --vol-ma-period N --vol-ma-mult N"
          );
        }

        return new VolumeFollowthrough({
          volThreshold: hasThreshold ? parseFloat(args['vol-threshold']!) : undefined,
          volMa:        hasMa ? (args['vol-ma'] as 'sma' | 'ema') : undefined,
          volMaPeriod:  args['vol-ma-period'] !== undefined ? parseInt(args['vol-ma-period']!, 10) : undefined,
          volMaMult:    args['vol-ma-mult']   !== undefined ? parseFloat(args['vol-ma-mult']!) : undefined,
          lookaheadN:   args['lookahead']     !== undefined ? parseInt(args['lookahead']!, 10) : 5,
        });
      }

      case 'consecutive-streaks': {
        const args = spec.args;
        const maxStreak = args['max-streak'] !== undefined
          ? parseInt(args['max-streak']!, 10)
          : 10;
        const direction = (args['direction'] ?? 'both') as 'both' | 'bullish' | 'bearish';

        if (!['both', 'bullish', 'bearish'].includes(direction)) {
          die(`consecutive-streaks --direction debe ser 'both', 'bullish' o 'bearish'. Recibido: '${direction}'`);
        }

        return new ConsecutiveStreaks({ maxStreak, direction });
      }

      case 'marubozu-continuation': {
        const analyzerArgs = spec.args;
        return new MarubozuContinuation({
          minRangePct:      parseFloat(analyzerArgs['min-range-pct'] ?? '0.5'),
          maxWickPct:       parseFloat(analyzerArgs['max-wick-pct']  ?? '10'),
          lookahead:        parseInt(analyzerArgs['lookahead']        ?? '20', 10),
          direction:        (analyzerArgs['direction'] ?? 'both') as 'both' | 'bullish' | 'bearish',
          macdEnabled:      'macd-filter' in analyzerArgs,
          macdFast:         parseInt(analyzerArgs['macd-fast']   ?? '12', 10),
          macdSlow:         parseInt(analyzerArgs['macd-slow']   ?? '26', 10),
          macdSignal:       parseInt(analyzerArgs['macd-signal'] ?? '9',  10),
          macdFilterSource: (analyzerArgs['macd-filter-source'] ?? 'line') as 'line' | 'histogram',
          macdThreshold:    parseFloat(analyzerArgs['macd-threshold'] ?? '0'),
          macdOp:           (analyzerArgs['macd-op'] ?? 'lt') as 'lt' | 'gt',
        });
      }

      case 'wickless-range-dist': {
        const args = spec.args;
        return new WicklessRangeDist({
          maxWickClosePct: parseFloat(args['max-wick-close'] ?? '1'),
          maxWickOpenPct:  parseFloat(args['max-wick-open']  ?? '5'),
          bucketSize:      parseFloat(args['bucket-size']    ?? '0.1'),
          maxRange:        parseFloat(args['max-range']      ?? '2'),
          direction:       (args['direction'] ?? 'both') as 'both' | 'bullish' | 'bearish',
        });
      }

      case 'rsi-zone-dist': {
        const args = spec.args;
        return new RSIZoneDist({
          rsiPeriod: parseInt(args['rsi-period'] ?? '14', 10),
          obLevel:   parseFloat(args['ob-level']  ?? '70'),
          osLevel:   parseFloat(args['os-level']  ?? '30'),
          zoneSize:  parseFloat(args['zone-size'] ?? '5'),
        });
      }

      case 'oversold-bounce': {
        const args = spec.args;
        return new OversoldBounce({
          rsiPeriod:    args['rsi-period'] !== undefined ? parseInt(args['rsi-period']!, 10) : undefined,
          osLevel:      args['os-level']   !== undefined ? parseFloat(args['os-level']!)     : undefined,
          stopPct:      args['stop-pct']   !== undefined ? parseFloat(args['stop-pct']!)     : undefined,
          rr:           args['rr']         !== undefined ? parseFloat(args['rr']!)           : undefined,
          lookahead:    args['lookahead']  !== undefined ? parseInt(args['lookahead']!, 10)  : undefined,
          requireCross: !('no-cross' in args),
          trendSma:     args['trend-sma']  !== undefined ? parseInt(args['trend-sma']!, 10)  : undefined,
        });
      }

      case 'ema-bounce': {
        const args = spec.args;
        return new EmaBounce({
          emaFast:          args['ema-fast'] !== undefined ? parseInt(args['ema-fast']!, 10)   : undefined,
          emaSlow:          args['ema-slow'] !== undefined ? parseInt(args['ema-slow']!, 10)   : undefined,
          tpPct:            args['tp-pct']   !== undefined ? parseFloat(args['tp-pct']!)        : undefined,
          slPct:            args['sl-pct']   !== undefined ? parseFloat(args['sl-pct']!)        : undefined,
          lookahead:        args['lookahead'] !== undefined ? parseInt(args['lookahead']!, 10) : undefined,
          minSeparationPct: args['min-sep']  !== undefined ? parseFloat(args['min-sep']!)       : undefined,
          touchEma:         args['touch-ema'] === 'slow' ? 'slow' : (args['touch-ema'] === 'fast' ? 'fast' : undefined),
          minTrendSepPct:   args['min-trend-sep'] !== undefined ? parseFloat(args['min-trend-sep']!) : undefined,
        });
      }

      default:
        die(`Analyzer desconocido: '${spec.name}'. Disponibles: volume-followthrough, consecutive-streaks, marubozu-continuation, wickless-range-dist, rsi-zone-dist, oversold-bounce, ema-bounce`);
        // never reached pero TypeScript lo necesita
        throw new Error();
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  console.error(`\nError: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const cli = parseArgs(argv);
  const analyzers = buildAnalyzers(cli.analyzers);

  const pool = createPool({ max: 2 });

  try {
    const repo   = new CandleRepository({ db: pool });
    const engine = new StatsEngine(repo);

    const results = await engine.run(
      {
        symbol:    cli.symbol,
        timeframe: cli.timeframe,
        from:      cli.from,
        to:        cli.to,
      },
      analyzers,
    );

    const reporterOpts = {
      symbol:    cli.symbol,
      timeframe: cli.timeframe,
      from:      cli.from,
      to:        cli.to,
    };

    let output: string;
    switch (cli.output) {
      case 'json':
        output = new JsonReporter(reporterOpts).render(results);
        break;
      case 'csv':
        output = new CsvReporter(reporterOpts).render(results);
        break;
      case 'table':
      default:
        output = new TableReporter(reporterOpts).render(results);
        break;
    }

    process.stdout.write(output + '\n');

    if (cli.save !== undefined) {
      const __dirname  = path.dirname(fileURLToPath(import.meta.url));
      const resultsDir = path.resolve(__dirname, '../results/stats');
      fs.mkdirSync(resultsDir, { recursive: true });

      const ext      = cli.output === 'json' ? 'json' : cli.output === 'csv' ? 'csv' : 'txt';
      const baseName = cli.save !== 'true'
        ? cli.save
        : `${cli.symbol}_${cli.timeframe}_${analyzers.map(a => a.name).join('_')}`;
      const date     = new Date().toISOString().slice(0, 10);
      const fileName = `${baseName}_${date}.${ext}`;
      const filePath = path.join(resultsDir, fileName);

      fs.writeFileSync(filePath, output, 'utf8');
      process.stderr.write(`\nGuardado en: results/stats/${fileName}\n`);
    }
  } finally {
    await pool.end();
  }
}

function printUsage(): void {
  console.log(`
NesxTrader Stats Engine

Uso:
  npm run stats -- --symbol BTCUSDT --timeframe 1m \\
    --from 2025-01-01 --to 2025-03-31 \\
    --analyzer <nombre> [opciones del analyzer] \\
    --output table|json|csv

Flags globales:
  --symbol       Par de trading (default: BTCUSDT)
  --timeframe    Timeframe: 1m, 5m, 15m, 30m, 1h (default: 1m)
  --from         Fecha inicio YYYY-MM-DD (requerido)
  --to           Fecha fin YYYY-MM-DD (requerido)
  --analyzer     Nombre del analyzer (repetible)
  --output       Formato de salida: table, json, csv (default: table)

Analyzers disponibles:

  volume-followthrough
    --vol-threshold N        Volumen mínimo absoluto
    --vol-ma sma|ema         Tipo de media móvil (alternativo a threshold)
    --vol-ma-period N        Período de la MA (requerido con --vol-ma)
    --vol-ma-mult N          Multiplicador sobre la MA (requerido con --vol-ma)
    --lookahead N            Velas futuras a analizar (default: 5)

  consecutive-streaks
    --max-streak N           Longitud máxima a reportar (default: 10)
    --direction both|bullish|bearish  (default: both)

  marubozu-continuation
    --min-range-pct N        Rango mínimo como % del precio (default: 0.5)
    --max-wick-pct N         Mecha máxima como % del rango (default: 10)
    --lookahead N            Velas para verificar TP/SL (default: 20)
    --direction both|bullish|bearish  (default: both)
    --macd-filter            Activa el filtro MACD (flag)
    --macd-fast N            Período rápido del MACD (default: 12)
    --macd-slow N            Período lento del MACD (default: 26)
    --macd-signal N          Período de señal del MACD (default: 9)
    --macd-filter-source line|histogram  Fuente del valor MACD (default: line)
    --macd-threshold N   Umbral para el filtro MACD: pasa si valor < N (default: 0)

Ejemplos:
  npm run stats -- --symbol BTCUSDT --timeframe 1m \\
    --from 2025-01-01 --to 2025-03-31 \\
    --analyzer volume-followthrough --vol-threshold 500 --lookahead 5

  npm run stats -- --symbol BTCUSDT --timeframe 1m \\
    --from 2025-01-01 --to 2025-01-31 \\
    --analyzer consecutive-streaks --max-streak 10

  npm run stats -- --symbol BTCUSDT --timeframe 1m \\
    --from 2025-01-01 --to 2025-01-31 \\
    --analyzer volume-followthrough --vol-ma sma --vol-ma-period 20 --vol-ma-mult 2 \\
    --analyzer consecutive-streaks
  `);
}

main().catch(err => {
  console.error('\nError fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
