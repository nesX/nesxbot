import type { AnalyzerResult } from '../types.js';

export interface TableReporterOptions {
  symbol:    string;
  timeframe: string;
  from:      number;
  to:        number;
}

/**
 * TableReporter
 *
 * Imprime los resultados de cada analyzer como una tabla ASCII en stdout.
 * Usa caracteres ASCII simples (no unicode box-drawing).
 * Separador de columnas con |, línea separadora con -.
 */
export class TableReporter {
  constructor(private readonly opts: TableReporterOptions) {}

  render(results: AnalyzerResult[]): string {
    const fromStr = this._formatDate(this.opts.from);
    const toStr   = this._formatDate(this.opts.to);
    const lines: string[] = [];

    for (const result of results) {
      lines.push('');
      lines.push(`${result.name} — ${this.opts.symbol} ${this.opts.timeframe} (${fromStr} → ${toStr})`);

      if (result.summary) {
        for (const [key, value] of Object.entries(result.summary)) {
          lines.push(`  ${key}: ${String(value)}`);
        }
      }
      lines.push('');

      if (result.rows.length === 0) {
        lines.push('  (sin datos)');
        lines.push('');
        continue;
      }

      const columns = Object.keys(result.rows[0]!);
      const colWidths = columns.map(col => {
        const headerLen  = col.length;
        const maxDataLen = Math.max(...result.rows.map(row => String(row[col] ?? '').length));
        return Math.max(headerLen, maxDataLen);
      });

      const separator = colWidths.map(w => '-'.repeat(w + 2)).join('+');
      const headerRow = columns.map((col, i) => ` ${col.padEnd(colWidths[i]!)} `).join('|');

      lines.push(headerRow);
      lines.push(separator);

      for (const row of result.rows) {
        const line = columns
          .map((col, i) => {
            const val       = String(row[col] ?? '');
            const isNumeric = /^-?[\d,]+(\.\d+)?%?$/.test(val.trim());
            return isNumeric
              ? ` ${val.padStart(colWidths[i]!)} `
              : ` ${val.padEnd(colWidths[i]!)} `;
          })
          .join('|');
        lines.push(line);
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  print(results: AnalyzerResult[]): void {
    process.stdout.write(this.render(results) + '\n');
  }

  private _formatDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
