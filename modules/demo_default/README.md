# Demo Default Module (Template)

This is a reference module showing the minimal contract for vHiH modules.

## Contract (must-have)
A module should export a default object with:

- `id` (string): stable module id (folder name can match)
- `enabled(cfg)` (optional but recommended): determines if module should run
- `discover(cfg, runtime)` -> `{ discoveredNodes }`
- `start(cfg, runtime)` (optional): start polling/SSE, build indices
- `stop()` (optional): cleanup timers / sockets
- `handleCommand(payload, runtime)` (required if attributes are writable)

### Payload shapes
#### Discovery NodeDef
```
{
  nodeKey, moduleId, name, profileKey,
  attributes: [
    {
      attrKey, name, attrTypeKey,
      min, max, step, unit,
      writable,
      currentValue, targetValue, lastValue,
      data: { ...module-defined JSON... }
    }
  ]
}
```

#### Homee PUT -> module.handleCommand
```
{
  attributeId: number,
  value: number,         // target_value
  data: object           // module-defined JSON stored in ids.json for that attributeId
}
```

#### Module telemetry -> Core
```
runtime.emitTelemetry({ attributeId, value, ts, source })
```

## Key idea
- ids.json is loaded once by Core at startup.
- Module builds its own index from `runtime.store.ids` for fast event -> attributeId mapping.
- Module never reads ids.json from disk.
