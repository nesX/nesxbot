import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Carga variables de entorno desde el archivo .env en el directorio raíz del proyecto.
 * No sobreescribe variables que ya existan en process.env.
 */
export function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    throw new Error(
      'No se encontró el archivo .env\n' +
      'Crea uno copiando .env.example y completando los valores:\n' +
      '  cp .env.example .env'
    );
  }

  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length > 0 && !(key.trim() in process.env)) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
}
