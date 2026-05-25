# ADR-0001: Aislamiento del bot en esquema `nesx` con solo-lectura sobre las velas

- **Fecha:** 2026-05-25
- **Estado:** aceptado

## Contexto
El bot comparte la base `market_tracker` con los datos de velas (binance_candles ~1.2M filas,
binance_klines_1s ~276M filas, irremplazables: no re-descargables de Binance). Se conectaba como
`postgres` (superusuario, dueño de todo) → cualquier script de la IA podía DROP/TRUNCATE/DELETE
las velas. El sandbox del harness es heurístico, no garantía.

## Decisión
- Rol `nesx_bot` (NOSUPERUSER, no dueño de las tablas de mercado).
- Esquema propio `nesx` (AUTHORIZATION nesx_bot) donde el bot trabaja con libertad total.
- SELECT-only sobre `public` y `_timescaledb_internal`; `search_path = nesx, public`.
- Migraciones del bot corren como `nesx_bot`; el setup de rol/esquema (db/setup-roles.sql) como `postgres`.

## Consecuencias
- Ningún script puede dañar las velas: Postgres rechaza la escritura por falta de permiso.
- Las tablas del bot viven en `nesx.*`; el código las referencia sin calificar (search_path).
- Costo: dos perfiles de conexión (admin para setup, nesx_bot para el día a día).
- Pendiente/condicionado: si market-tracker escribe velas con un rol distinto de `postgres`,
  hay que repetir el `ALTER DEFAULT PRIVILEGES` con ese rol para que el bot lea velas nuevas.

## Alternativas consideradas
- **Solo grants por tabla (sin esquema propio):** funciona pero re-otorgar en cada migración es frágil.
- **Base separada para el bot:** sin joins cross-DB; fricción de dos conexiones sin beneficio real.
- **Confiar en el sandbox / disciplina de código:** no es garantía; un script con conexión full puede borrar.
