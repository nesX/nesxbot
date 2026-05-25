# Documentación técnica

Registro de lo que se agrega al código y por qué. Para tener trazabilidad a lo largo
de meses y no perder el "qué" ni el "porqué" cuando se resetea el contexto.

| Documento | Para qué |
|-----------|----------|
| [tools.md](tools.md) | **Registro de herramientas** — cada CLI, librería o analizador que creamos, qué hace y dónde vive. Se actualiza al agregar tooling. |
| [adr/](adr/) | **Architecture Decision Records** — decisiones de arquitectura y fixes importantes, con su contexto y consecuencias. Una por decisión, numeradas. |

Convención:
- **Herramienta nueva** (CLI, analizador, helper reutilizable) → agregar fila en `tools.md`.
- **Decisión de arquitectura o fix con impacto** (cambia resultados, contratos, o seguridad)
  → nuevo ADR en `adr/` usando `adr/_template.md`.
- Auditorías de código puntuales → `docs/audit/`.
- Bitácoras de experimentos de estrategia → `docs/experiments/`.
