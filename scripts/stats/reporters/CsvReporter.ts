import type { AnalyzerResult } from '../types.js';

export interface CsvReporterOptions {
  symbol:    string;
  timeframe: string;
  from:      number;
  to:        number;
}

/**
 * CsvReporter
 *
 * Exporta los resultados de cada analyzer como CSV a stdout.
 * Si hay múltiples analyzers, cada uno se separa con una línea en blanco
 * y una línea de comentario con el nombre del analyzer.
 */
export class CsvReporter {
  constructor(private readonly opts: CsvReporterOptions) {}

  render(results: AnalyzerResult[]): string {
    const fromStr = new Date(this.opts.from).toISOString().slice(0, 10);
    const toStr   = new Date(this.opts.to).toISOString().slice(0, 10);
    const lines: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (i > 0) lines.push('');

      lines.push(`# ${result.name} — ${this.opts.symbol} ${this.opts.timeframe} (${fromStr} → ${toStr})`);

      if (result.rows.length === 0) {
        lines.push('# (sin datos)');
        continue;
      }

      const columns = Object.keys(result.rows[0]!);
      lines.push(columns.map(c => this._escape(c)).join(','));

      for (const row of result.rows) {
        lines.push(columns.map(col => this._escape(String(row[col] ?? ''))).join(','));
      }

      if (result.summary) {
        lines.push('# Resumen:');
        for (const [key, value] of Object.entries(result.summary)) {
          lines.push(`# ${key}: ${String(value)}`);
        }
      }
    }

    return lines.join('\n');
  }

  print(results: AnalyzerResult[]): void {
    process.stdout.write(this.render(results) + '\n');
  }

  /**
   * Escapa un valor CSV: si contiene comas, comillas o saltos de línea,
   * lo envuelve en comillas dobles y escapa las comillas internas.
   */
  private _escape(value: string): string {
    if (/[",\n\r]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
}
