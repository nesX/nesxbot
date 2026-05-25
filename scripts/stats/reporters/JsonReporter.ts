import type { AnalyzerResult } from '../types.js';

export interface JsonReporterOptions {
  symbol:    string;
  timeframe: string;
  from:      number;
  to:        number;
}

/**
 * JsonReporter
 *
 * Vuelca los resultados de todos los analyzers como JSON a stdout.
 */
export class JsonReporter {
  constructor(private readonly opts: JsonReporterOptions) {}

  render(results: AnalyzerResult[]): string {
    return JSON.stringify({
      symbol:    this.opts.symbol,
      timeframe: this.opts.timeframe,
      from:      new Date(this.opts.from).toISOString().slice(0, 10),
      to:        new Date(this.opts.to).toISOString().slice(0, 10),
      analyzers: results,
    }, null, 2);
  }

  print(results: AnalyzerResult[]): void {
    process.stdout.write(this.render(results) + '\n');
  }
}
