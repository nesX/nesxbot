# {{ID}}: {{TITULO}}

- **Estado:** explorando
- **Estrategia:** {{ESTRATEGIA}}
- **Rama git:** {{BRANCH}}
- **Creado:** {{DATE}}
- **Datos:** símbolo BTCUSDT · IS \<rango\> · OOS \<rango\>

> Las corridas de este experimento quedan en `nesx.backtest_runs` con
> `experiment = '{{ID}}'`. Consúltalas con:
> `npm run compare-runs -- --experiment {{ID}}`

## Hipótesis
<Qué creemos y por qué. Qué esperamos que mejore y respecto a qué baseline.>

## Qué se probó
<Variaciones de params / rangos / filtros. Cada corrida es reproducible por su
fingerprint — el mismo comando no se re-ejecuta (dedup).>

## Resultados clave
| runId | params destacados | window | trades | PF | maxDD | veredicto |
|-------|-------------------|--------|--------|----|----|-----------|
|       |                   |        |        |    |    |           |

## Observaciones
<Qué se vio. Incluir advertencias de la CLI: overfitting, % PESSIMISTIC, pocos trades.>

## Conclusión
<Qué aprendimos. Por qué se promueve (promising) o se descarta (rejected).>

## Siguientes pasos
<Qué probar después, o qué hipótesis abrió esto.>
