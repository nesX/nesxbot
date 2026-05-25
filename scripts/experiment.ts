/**
 * scripts/experiment.ts
 *
 * Red de seguridad git para el bucle de iteración de estrategias.
 * Cada experimento vive en una rama exp/<nombre>; cada iteración es un commit
 * que SOLO se crea si pasan typecheck + tests (mismo gate que el pre-push hook).
 * Así cualquier iteración que rompa o borre código es reversible con git.
 *
 * Uso:
 *   npm run exp -- new <nombre>          # crea y cambia a la rama exp/<nombre>
 *   npm run exp -- iterate "<mensaje>"   # gate (typecheck+tests) y commit si pasa
 *   npm run exp -- log                   # historial de iteraciones de la rama
 *
 * Rollback (git directo):
 *   git log --oneline                    # ver iteraciones
 *   git reset --hard <sha>               # volver a una iteración previa (descarta cambios)
 *   git checkout <sha> -- <archivo>      # recuperar un archivo borrado/roto
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function sh(cmd: string, opts: { capture?: boolean } = {}): string {
  return execSync(cmd, { stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf-8' }) ?? '';
}

function shTry(cmd: string): { ok: boolean } {
  try { execSync(cmd, { stdio: 'inherit' }); return { ok: true }; }
  catch { return { ok: false }; }
}

function currentBranch(): string {
  return sh('git rev-parse --abbrev-ref HEAD', { capture: true }).trim();
}

function cmdNew(name: string): void {
  if (!name) throw new Error('Falta el nombre. Uso: npm run exp -- new <nombre>');
  const id     = name.replace(/^exp\//, '');
  const branch = `exp/${id}`;
  sh(`git checkout -b ${branch}`);

  // Generar el archivo narrativo del experimento desde la plantilla.
  const docPath = resolve(process.cwd(), `docs/experiments/${id}.md`);
  if (!existsSync(docPath)) {
    const tplPath = resolve(process.cwd(), 'docs/experiments/_template.md');
    const date    = new Date().toISOString().slice(0, 10);
    const doc = readFileSync(tplPath, 'utf-8')
      .replace(/\{\{ID\}\}/g, id)
      .replace(/\{\{TITULO\}\}/g, '<título corto>')
      .replace(/\{\{ESTRATEGIA\}\}/g, '<spinning-top-fib | ...>')
      .replace(/\{\{BRANCH\}\}/g, branch)
      .replace(/\{\{DATE\}\}/g, date);
    writeFileSync(docPath, doc, 'utf-8');
    console.log(`\nRama creada: ${branch}`);
    console.log(`Bitácora:    docs/experiments/${id}.md  (complétala con tu hipótesis)`);
  } else {
    console.log(`\nRama creada: ${branch}  (la bitácora docs/experiments/${id}.md ya existía)`);
  }
  console.log(`Corre backtests con:  npm run rbt -- --strategy <tipo> --experiment ${id} ...`);
  console.log(`Itera con:            npm run exp -- iterate "lo que cambiaste"`);
}

function cmdIterate(message: string): void {
  if (!message) throw new Error('Falta el mensaje. Uso: npm run exp -- iterate "<mensaje>"');

  const branch = currentBranch();
  if (!branch.startsWith('exp/')) {
    throw new Error(`No estás en una rama de experimento (estás en "${branch}"). Crea una con: npm run exp -- new <nombre>`);
  }

  console.log('[ gate ] typecheck (src + scripts)...');
  if (!shTry('npm run typecheck').ok || !shTry('npm run typecheck:all').ok) {
    console.error('\n[ gate ] BLOQUEADO — errores de TypeScript. La iteración NO se commiteó.');
    process.exit(1);
  }
  console.log('[ gate ] tests...');
  if (!shTry('npm test').ok) {
    console.error('\n[ gate ] BLOQUEADO — tests fallando. La iteración NO se commiteó.');
    process.exit(1);
  }

  // ¿Hay algo que commitear?
  const status = sh('git status --porcelain', { capture: true }).trim();
  if (!status) {
    console.log('\n[ gate ] OK pero no hay cambios para commitear.');
    return;
  }

  sh('git add -A');
  sh(`git commit -m ${JSON.stringify(`exp: ${message}`)}`);
  console.log(`\n[ gate ] OK — iteración commiteada en ${branch}.`);
}

function cmdLog(): void {
  const branch = currentBranch();
  console.log(`\nIteraciones en ${branch}:\n`);
  sh('git log --oneline -20');
}

function main(): void {
  const [sub, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ').trim();

  switch (sub) {
    case 'new':     cmdNew(arg); break;
    case 'iterate': cmdIterate(arg); break;
    case 'log':     cmdLog(); break;
    default:
      console.log('Subcomandos: new <nombre> | iterate "<mensaje>" | log');
      process.exit(sub ? 1 : 0);
  }
}

main();
