---
name: Feedback
description: Correcciones y preferencias de colaboración del usuario
type: feedback
---

## Respuestas cortas y directas
No resumir lo que acabo de hacer al final de cada respuesta.
**Why:** El usuario puede leer el diff. Prefiere respuestas directas sin relleno.
**How to apply:** Ir al punto. Sin párrafos de "resumen de cambios realizados".

## No implementar lógica de otro módulo sin consultar
Cada módulo tiene su sub-agente en `.claude/agents/`. No tocar código de otros módulos sin necesidad.
**Why:** Arquitectura deliberada con separación de responsabilidades.
**How to apply:** Si una tarea requiere cambiar otro módulo, mencionarlo antes de hacerlo.

## Validar antes de correr procesos largos
El usuario prefiere verificar correctitud antes de ejecutar backtests de horas.
**Why:** Paró un backtest de 3h para primero arreglar las queries de TimescaleDB.
**How to apply:** Cuando hay dudas sobre correctitud, sugerir EXPLAIN ANALYZE / test rápido primero.

## CandleAggregator desacoplado de infraestructura
Debe vivir en `src/strategy/` como función pura sin IO.
**Why:** El usuario lo pidió explícitamente para reutilización en futuras estrategias.
**How to apply:** Nuevas estrategias que necesiten agregar velas importan de `src/strategy/CandleAggregator.ts`.




