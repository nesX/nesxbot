-- ============================================================================
-- setup-roles.sql
--
-- Aísla NesxTrader en un esquema propio (nesx) donde trabaja con libertad total,
-- y le da SOLO LECTURA sobre el resto de la base (velas y demás esquemas).
-- Así ningún script — ni de la IA ni tuyo — puede borrar/alterar las velas:
-- el rol del bot simplemente no tiene el permiso.
--
-- EJECUTAR UNA SOLA VEZ, COMO SUPERUSUARIO (postgres), COMANDO POR COMANDO.
-- Base objetivo: market_tracker (PostgreSQL 16 + TimescaleDB).
-- ============================================================================


-- (1) Rol de aplicación del bot: SIN superuser, SIN crear DBs/roles.
--     Cambia la clave por una real.
CREATE ROLE nesx_bot WITH LOGIN PASSWORD 'CAMBIA_ESTA_CLAVE' NOSUPERUSER NOCREATEDB NOCREATEROLE;


-- (2) Permitir que el bot se conecte a la base.
GRANT CONNECT ON DATABASE market_tracker TO nesx_bot;


-- (3) Esquema propio del bot. AUTHORIZATION = lo hace DUEÑO → puede
--     crear/alterar/borrar/truncar SUS tablas aquí con total libertad.
CREATE SCHEMA IF NOT EXISTS nesx AUTHORIZATION nesx_bot;
ALTER SCHEMA nesx OWNER TO nesx_bot;

-- (4) search_path del rol: primero su esquema (nesx), luego public (velas).
--     Hace que el código del bot encuentre sus tablas en nesx y las velas en public
--     sin tener que calificar nombres.
ALTER ROLE nesx_bot SET search_path = nesx, public;


-- (5) Defensa: quitar el permiso de crear objetos en public.
--     (En PG15+ ya viene revocado por defecto; aquí es no-op/cinturón y tirantes.)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;


-- (6) SOLO LECTURA sobre public (donde están binance_candles y binance_klines_1s).
GRANT USAGE  ON SCHEMA public TO nesx_bot;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nesx_bot;


-- (7) Que las tablas FUTURAS creadas en public (por postgres) también sean
--     legibles por el bot — pero NUNCA escribibles. Si market-tracker crea velas
--     con otro rol distinto de postgres, repite este ALTER con ese rol.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO nesx_bot;


-- (8) TimescaleDB: la hypertable binance_klines_1s guarda sus chunks en
--     _timescaledb_internal. En TimescaleDB 2.x el GRANT SELECT sobre la
--     hypertable (paso 6) se propaga a los chunks automáticamente; basta con
--     dar USAGE sobre el esquema interno para poder atravesarlo al consultar.
GRANT USAGE ON SCHEMA _timescaledb_internal TO nesx_bot;

--     Si al leer velas de 1s falla por permisos (raro), ejecuta también estos
--     dos (lectura de chunks existentes y futuros) — descoméntalos:
-- GRANT SELECT ON ALL TABLES IN SCHEMA _timescaledb_internal TO nesx_bot;
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA _timescaledb_internal
--   GRANT SELECT ON TABLES TO nesx_bot;


-- (9) Limpiar las tablas de backtest que se crearon antes en public.
--     Contienen datos de prueba CONTAMINADOS (anteriores al fix de lookahead H1).
--     init-db las recreará en el esquema nesx, limpias.
DROP TABLE IF EXISTS public.backtest_trades CASCADE;
DROP TABLE IF EXISTS public.backtest_runs   CASCADE;


-- (10) VERIFICACIÓN — el bot NO debe poder escribir velas.
--      Ejecuta estas 3 líneas: la del DELETE DEBE fallar con "permission denied".
--      SET ROLE nesx_bot;
--      DELETE FROM public.binance_klines_1s WHERE false;   -- ← debe ser RECHAZADO
--      RESET ROLE;

--      Y esta DEBE funcionar (lectura de velas):
--      SET ROLE nesx_bot;
--      SELECT count(*) FROM public.binance_candles WHERE symbol = 'BTCUSDT' AND timeframe = '1m';
--      RESET ROLE;


-- ============================================================================
-- DESPUÉS de correr esto:
--   1. En el archivo .env del proyecto, cambia:
--        DB_USER=nesx_bot
--        DB_PASSWORD=la_clave_que_pusiste_arriba
--   2. Recrea las tablas del bot en el esquema nesx:
--        npm run init-db          (ahora corre como nesx_bot, crea en nesx)
--   3. Las migraciones que toquen OTROS esquemas (no pasa hoy) se corren como
--      postgres, no como nesx_bot.
-- ============================================================================
