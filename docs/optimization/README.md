# Optimización de Estrategias — Índice

Carpeta dedicada al proceso científico de validación y ajuste de parámetros.

## Estructura

```
docs/optimization/
├── README.md                    ← este archivo (índice + convenciones)
├── plan-maestro.md              ← plan de todas las fases con estado actual
├── fase-1-tf-tp.md              ← ❌ TF + TP (re-run necesario — bugs corregidos)
├── fase-2-zonas.md              ← ❌ Proyecciones zona 1 (re-run necesario — bugs corregidos)
├── fase-3-rango.md              ← ⏳ minRangePercent (pendiente — espera re-run Fase 1+2)
├── fase-4-cuerpo.md             ← ⏳ maxBodyPercent (pendiente)
├── fase-5-volumen.md            ← ⏳ minVolume (pendiente)
└── resultados/                  ← CSVs de grid search nombrados por fase
    └── fase-1-grid-search-run1.csv
```

> Los archivos CSV de trades individuales siguen en `docs/backtest/results/`

## Convenciones

- Cada fase tiene su propio archivo con: hipótesis, configuración del grid, resultados y conclusiones
- Estado de cada fase: ✅ completada | 🔄 en curso | ⏳ pendiente | ❌ descartada
- Al completar una fase, actualizar `plan-maestro.md` con los parámetros fijados

## Parámetros fijados hasta ahora

| Parámetro | Valor | Estado | Fijado en |
|-----------|-------|--------|-----------|
| `zone2` | deshabilitada | ✅ Firme (decisión de diseño) | Fase 2 |
| `tp1SizePercent` | 100% | ✅ Firme (decisión de diseño) | Fase 1 |
| `moveSlToBreakeven` | false | ✅ Firme (decisión de diseño) | Fase 1 |
| `z1min` | 1.95 (tentativo) | ❌ Pendiente re-run Fase 2 | Fase 2 |
| `z1max` | 2.06 (tentativo) | ❌ Pendiente re-run Fase 2 | Fase 2 |

> Los valores de `z1min` y `z1max` son tentativos — se basaron en resultados inválidos (bugs corregidos).
> Se deben confirmar re-ejecutando Fase 1 y Fase 2.
